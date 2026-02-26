/**
 * Template Runner — engine for interactive guided tutorials.
 *
 * A LivingTemplate creates a split-view window: terminal on the left,
 * interactive guide page on the right. The guide watches the filesystem,
 * verifies checkpoints, and communicates with the terminal via postMessage.
 */

import type { Shell } from './shell';
import { spawnInWindow } from './commands/spawn';
import { processTable } from './process-table';

export interface Checkpoint {
  id: string;
  verify: {
    type: 'file-exists' | 'file-contains' | 'command-succeeds';
    path?: string;
    pattern?: string;
    command?: string;
  };
}

export interface LivingTemplate {
  id: string;
  name: string;
  genre: 'quest' | 'mirror' | 'automator' | 'canvas' | 'collaborator';
  level: 'beginner' | 'intermediate' | 'advanced';
  icon: string;
  desc: string;
  time: string;
  learns: string[];

  /** Inline HTML for the guide page served in split view */
  guideHtml: string;

  /** Port to serve the guide on */
  guidePort: number;

  /** Shell commands to run before guide shows (setup files, etc.) */
  setup: string[];

  /** Working directory for the user's REPL */
  workDir: string;

  /** Checkpoints the guide can verify */
  checkpoints: Checkpoint[];
}

/** Wrap guide HTML with the bridge script that handles postMessage protocol */
function wrapGuideHtml(html: string, templateId: string, checkpoints: Checkpoint[]): string {
  // Inject bridge script before </body>
  const bridgeScript = `
<script>
(function() {
  var templateId = ${JSON.stringify(templateId)};
  var checkpoints = ${JSON.stringify(checkpoints)};

  // Load saved progress (stored in parent's localStorage via postMessage)
  var progressKey = 'shiro-template-progress-' + templateId;
  var completed = {};

  // Expose to guide page
  window.__bridge = {
    templateId: templateId,
    checkpoints: checkpoints,
    completed: completed,
    saveProgress: function() {
      parent.postMessage({
        type: 'shiro-guide-save-progress',
        key: progressKey,
        value: JSON.stringify(completed)
      }, '*');
    },
    // Send a check request to the parent
    checkFile: function(path, contains) {
      parent.postMessage({
        type: 'shiro-guide-check',
        checkType: contains ? 'file-contains' : 'file-exists',
        path: path,
        pattern: contains || null,
        requestId: Math.random().toString(36).slice(2)
      }, '*');
    },
    // Ask parent to run a command in the terminal
    execInTerminal: function(command) {
      parent.postMessage({
        type: 'shiro-guide-exec',
        command: command
      }, '*');
    },
    // Report progress
    reportProgress: function(step, total) {
      parent.postMessage({
        type: 'shiro-guide-progress',
        templateId: templateId,
        step: step,
        total: total
      }, '*');
    },
    // Mark a checkpoint as complete
    completeCheckpoint: function(id) {
      completed[id] = true;
      this.saveProgress();
      this.reportProgress(
        Object.keys(completed).length,
        checkpoints.length
      );
    }
  };

  // Listen for results from parent
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'shiro-guide-result') {
      var evt = new CustomEvent('shiro-check-result', { detail: e.data });
      window.dispatchEvent(evt);
    }
    if (e.data && e.data.type === 'shiro-guide-fs-change') {
      var evt2 = new CustomEvent('shiro-fs-change', { detail: e.data });
      window.dispatchEvent(evt2);
    }
    if (e.data && e.data.type === 'shiro-guide-loaded-progress') {
      try {
        var saved = JSON.parse(e.data.value || '{}');
        for (var k in saved) { completed[k] = saved[k]; }
        window.dispatchEvent(new CustomEvent('shiro-progress-loaded', { detail: completed }));
      } catch(e) {}
    }
  });

  // Request saved progress from parent
  parent.postMessage({ type: 'shiro-guide-load-progress', key: progressKey }, '*');
})();
</script>`;

  // Insert before </body> or append
  if (html.includes('</body>')) {
    return html.replace('</body>', bridgeScript + '\n</body>');
  }
  return html + bridgeScript;
}

/**
 * Run a LivingTemplate: set up files, start guide server, open split window.
 */
export async function runLivingTemplate(
  shell: Shell,
  template: LivingTemplate,
): Promise<void> {
  const fs = shell.fs;

  // 1. Create working directory
  await fs.mkdir(template.workDir, { recursive: true });

  // 2. Run setup commands silently (create files, set up environment)
  for (const cmd of template.setup) {
    await shell.execute(cmd, () => {}, () => {});
  }

  // 3. Write guide HTML to a temp directory and serve it
  const guideDir = `/tmp/.guides/${template.id}`;
  await fs.mkdir(guideDir, { recursive: true });

  const wrappedHtml = wrapGuideHtml(template.guideHtml, template.id, template.checkpoints);
  await fs.writeFile(`${guideDir}/index.html`, wrappedHtml);

  // Start guide server
  await shell.execute(
    `serve ${guideDir} ${template.guidePort}`,
    () => {},
    () => {},
  );

  // 4. Spawn window with terminal + guide split
  const { pid } = spawnInWindow(
    shell,
    `cd ${template.workDir}`,
    template.name,
    template.guidePort,
  );

  // 5. Wire up the bridge protocol: listen for postMessage from guide iframe
  const bridgeHandler = async (e: MessageEvent) => {
    if (!e.data || typeof e.data.type !== 'string') return;

    // Find the guide iframe in this window
    const win = document.querySelector(`[data-server-window]`);
    if (!win) return;
    const guideIframe = win.querySelector(`iframe[data-virtual-port="${template.guidePort}"]`) as HTMLIFrameElement | null;

    if (e.data.type === 'shiro-guide-check') {
      const { checkType, path, pattern, requestId } = e.data;
      let passed = false;

      try {
        if (checkType === 'file-exists') {
          passed = await fs.exists(path);
        } else if (checkType === 'file-contains') {
          const content = await fs.readFile(path, 'utf8') as string;
          passed = content.includes(pattern);
        } else if (checkType === 'command-succeeds') {
          const code = await shell.execute(e.data.command, () => {}, () => {});
          passed = code === 0;
        }
      } catch {
        passed = false;
      }

      guideIframe?.contentWindow?.postMessage({
        type: 'shiro-guide-result',
        passed,
        requestId,
        checkType,
        path,
      }, '*');
    }

    if (e.data.type === 'shiro-guide-exec') {
      // Find the window terminal and type the command
      const proc = processTable.get(pid);
      if (proc?.windowTerminal) {
        const wt = proc.windowTerminal;
        // Type the command character by character for visual effect
        const cmd = e.data.command;
        for (const ch of cmd) {
          wt.term.paste(ch);
          await new Promise(r => setTimeout(r, 30));
        }
        // Press enter
        wt.term.paste('\r');
      }
    }

    if (e.data.type === 'shiro-guide-save-progress') {
      // Store progress in main page's localStorage
      try { localStorage.setItem(e.data.key, e.data.value); } catch {}
    }

    if (e.data.type === 'shiro-guide-load-progress') {
      // Send saved progress back to guide iframe
      const value = localStorage.getItem(e.data.key) || '{}';
      guideIframe?.contentWindow?.postMessage({
        type: 'shiro-guide-loaded-progress',
        value,
      }, '*');
    }

    if (e.data.type === 'shiro-guide-progress') {
      // Progress event (informational)
    }
  };

  window.addEventListener('message', bridgeHandler);

  // 6. Wire filesystem change notifications to guide iframe
  const unsub = fs.onChange((event, path, newPath) => {
    // Find the guide iframe
    const iframes = document.querySelectorAll(`iframe[data-virtual-port="${template.guidePort}"]`);
    for (const iframe of iframes) {
      (iframe as HTMLIFrameElement).contentWindow?.postMessage({
        type: 'shiro-guide-fs-change',
        event,
        path,
        newPath,
      }, '*');
    }
  });

  // Cleanup when the window closes (process exits)
  const checkInterval = setInterval(() => {
    const proc = processTable.get(pid);
    if (!proc || proc.status !== 'running') {
      window.removeEventListener('message', bridgeHandler);
      unsub();
      clearInterval(checkInterval);
    }
  }, 2000);
}
