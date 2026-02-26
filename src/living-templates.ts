/**
 * Living Templates — interactive guided tutorials with split-view guides.
 *
 * Each template creates a terminal + guide page that watches the filesystem,
 * verifies checkpoints, and tells a story.
 */

import type { LivingTemplate } from './template-runner';

// ─── Quest: Mission Control ───────────────────────────────────────────

const missionControlGuide = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission Control</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Courier New', monospace;
    background: #0a0e1a;
    color: #c0c8e0;
    padding: 20px;
    line-height: 1.6;
  }
  .header {
    text-align: center;
    padding: 20px 0;
    border-bottom: 1px solid #1a2040;
    margin-bottom: 20px;
  }
  .header h1 {
    color: #ff4444;
    font-size: 20px;
    text-transform: uppercase;
    letter-spacing: 3px;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  .status-ok .header h1 {
    color: #44ff88;
    animation: none;
  }
  .alert {
    background: rgba(255, 68, 68, 0.1);
    border: 1px solid #ff4444;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 13px;
  }
  .alert.resolved {
    background: rgba(68, 255, 136, 0.1);
    border-color: #44ff88;
    color: #44ff88;
  }
  .step {
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
    transition: all 0.3s;
  }
  .step.active {
    border-color: #3b82f6;
    box-shadow: 0 0 12px rgba(59, 130, 246, 0.2);
  }
  .step.done {
    border-color: #22c55e;
    opacity: 0.7;
  }
  .step.locked {
    opacity: 0.4;
  }
  .step-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .step-num {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #1e293b;
    color: #64748b;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: bold;
    flex-shrink: 0;
  }
  .step.done .step-num {
    background: #22c55e;
    color: #000;
  }
  .step.active .step-num {
    background: #3b82f6;
    color: #fff;
  }
  .step-title {
    font-size: 14px;
    font-weight: bold;
    color: #e2e8f0;
  }
  .step-desc {
    font-size: 12px;
    color: #94a3b8;
    margin-left: 38px;
  }
  .cmd-btn {
    display: inline-block;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 4px 10px;
    margin: 6px 0 2px 38px;
    cursor: pointer;
    color: #60a5fa;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    transition: background 0.2s;
  }
  .cmd-btn:hover { background: #334155; }
  .cmd-btn:active { background: #475569; }
  .narrative {
    font-style: italic;
    color: #8b9dc3;
    padding: 12px 0;
    font-size: 13px;
    border-left: 2px solid #334155;
    padding-left: 12px;
    margin: 12px 0;
  }
  .progress-bar {
    height: 4px;
    background: #1e293b;
    border-radius: 2px;
    margin: 16px 0;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #22c55e);
    border-radius: 2px;
    transition: width 0.5s ease;
  }
  .finale {
    display: none;
    text-align: center;
    padding: 30px 20px;
  }
  .finale h2 {
    color: #22c55e;
    font-size: 18px;
    margin-bottom: 12px;
  }
  .finale p {
    color: #94a3b8;
    font-size: 13px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1 id="title">ALERT: SYSTEMS OFFLINE</h1>
    <div class="progress-bar"><div class="progress-fill" id="progress" style="width: 0%"></div></div>
  </div>

  <div class="alert" id="alert-msg">
    Station sensors detect critical failures across multiple subsystems.
    You are the only engineer online. Use your terminal to diagnose and repair.
  </div>

  <div class="narrative" id="narrative">
    The year is 2847. You've just been woken from cryo-sleep by an alarm.
    Red lights pulse through the corridor. The station's AI is offline.
    All you have is a terminal. Time to work.
  </div>

  <div id="steps">
    <div class="step active" id="step-1">
      <div class="step-header">
        <div class="step-num">1</div>
        <div class="step-title">Read the damage report</div>
      </div>
      <div class="step-desc">The ship's status log might tell us what happened.</div>
      <div class="cmd-btn" onclick="bridge.execInTerminal('cat /var/ship/status.log')">cat /var/ship/status.log</div>
    </div>

    <div class="step locked" id="step-2">
      <div class="step-header">
        <div class="step-num">2</div>
        <div class="step-title">Set navigation coordinates</div>
      </div>
      <div class="step-desc">We're drifting. Write new coordinates to the nav system.</div>
      <div class="cmd-btn" onclick="bridge.execInTerminal(&quot;echo '47.3 -122.6' > /var/ship/coords.txt&quot;)">echo '47.3 -122.6' > /var/ship/coords.txt</div>
    </div>

    <div class="step locked" id="step-3">
      <div class="step-header">
        <div class="step-num">3</div>
        <div class="step-title">Find the crew manifest</div>
      </div>
      <div class="step-desc">Search the logs for crew status information.</div>
      <div class="cmd-btn" onclick="bridge.execInTerminal('grep crew /var/ship/status.log')">grep crew /var/ship/status.log</div>
    </div>

    <div class="step locked" id="step-4">
      <div class="step-header">
        <div class="step-num">4</div>
        <div class="step-title">Fix the engine script</div>
      </div>
      <div class="step-desc">The ignition sequence has a typo. Edit line 3: change "fule" to "fuel".</div>
      <div class="cmd-btn" onclick="bridge.execInTerminal('vi /var/ship/engine.sh')">vi /var/ship/engine.sh</div>
    </div>

    <div class="step locked" id="step-5">
      <div class="step-header">
        <div class="step-num">5</div>
        <div class="step-title">Launch the dashboard</div>
      </div>
      <div class="step-desc">Serve the station's control panel so the crew can see it.</div>
      <div class="cmd-btn" onclick="bridge.execInTerminal('serve /var/ship/dashboard 4000')">serve /var/ship/dashboard 4000</div>
    </div>
  </div>

  <div class="finale" id="finale">
    <h2>ALL SYSTEMS OPERATIONAL</h2>
    <p>You just saved the station using nothing but a terminal.</p>
    <p style="margin-top: 12px; color: #64748b;">
      Commands you learned: <strong>cat</strong>, <strong>echo</strong>,
      <strong>grep</strong>, <strong>vi</strong>, <strong>serve</strong>
    </p>
    <p style="margin-top: 16px; color: #475569; font-size: 11px;">
      The terminal is still open. Try exploring: <code>ls /var/ship</code>
    </p>
  </div>

<script>
var bridge = window.__bridge;
var totalSteps = 5;
var currentStep = 1;

// Restore progress
var completedCount = Object.keys(bridge.completed).length;
if (completedCount > 0) {
  for (var i = 1; i <= completedCount && i <= totalSteps; i++) {
    markDone(i);
  }
  currentStep = Math.min(completedCount + 1, totalSteps + 1);
  if (currentStep <= totalSteps) {
    activateStep(currentStep);
  }
}

function markDone(n) {
  var el = document.getElementById('step-' + n);
  if (el) {
    el.classList.remove('active', 'locked');
    el.classList.add('done');
  }
}

function activateStep(n) {
  var el = document.getElementById('step-' + n);
  if (el) {
    el.classList.remove('locked');
    el.classList.add('active');
  }
}

function advanceStep() {
  markDone(currentStep);
  bridge.completeCheckpoint('step-' + currentStep);
  currentStep++;

  var pct = Math.min(100, Math.round(((currentStep - 1) / totalSteps) * 100));
  document.getElementById('progress').style.width = pct + '%';

  if (currentStep > totalSteps) {
    // All done!
    document.getElementById('title').textContent = 'ALL SYSTEMS ONLINE';
    document.body.classList.add('status-ok');
    document.getElementById('alert-msg').textContent = 'All subsystems nominal. Station is stable.';
    document.getElementById('alert-msg').classList.add('resolved');
    document.getElementById('narrative').textContent = 'The lights turn green. The hum of the engines fills the corridor. You did it.';
    document.getElementById('finale').style.display = 'block';
  } else {
    activateStep(currentStep);
    updateNarrative(currentStep);
  }
}

function updateNarrative(step) {
  var narratives = {
    2: 'Good. The damage report is clear. Now we need to set a course before we drift into the asteroid field.',
    3: 'Navigation locked. But we need to find out who else survived. Search the logs.',
    4: 'The crew is safe in cryo. But the engine won\\'t start — there\\'s a bug in the ignition script. You\\'ll need to edit it.',
    5: 'Engines are online! One last thing: bring up the control dashboard so the crew can monitor systems when they wake up.',
  };
  if (narratives[step]) {
    document.getElementById('narrative').textContent = narratives[step];
  }
}

// Watch for filesystem changes
window.addEventListener('shiro-fs-change', function(e) {
  var d = e.detail;
  if (currentStep === 1 && d.path === '/var/ship/status.log' && d.event === 'write') {
    // They catted the file — but cat doesn't write. We check on any activity.
  }
  if (currentStep === 2 && d.path === '/var/ship/coords.txt') {
    // Verify it contains the right coordinates
    bridge.checkFile('/var/ship/coords.txt', '47.3');
  }
  if (currentStep === 4 && d.path === '/var/ship/engine.sh') {
    // Check the typo was fixed
    bridge.checkFile('/var/ship/engine.sh', 'fuel');
  }
});

// For step 1 (cat) — detect when command runs by polling
// The guide can't detect cat (it's read-only), so we use a small trick:
// After exec, the user has "seen" the log — mark step done after a delay
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'shiro-guide-exec' && currentStep === 1) {
    // The button was clicked — they read the log
    setTimeout(function() { if (currentStep === 1) advanceStep(); }, 1500);
  }
});

// Also detect direct typing of cat command by listening for any exec
// Use a simpler approach: poll for step 1 completion after 3s
// (the setup writes the file, user just needs to read it)
var step1Timer = null;
if (currentStep === 1) {
  // Give them 2s to read the log after clicking the button
  // Also set up a listener that auto-advances when they interact
}

// Handle check results
window.addEventListener('shiro-check-result', function(e) {
  var d = e.detail;
  if (d.passed) {
    if (currentStep === 2 && d.path === '/var/ship/coords.txt') advanceStep();
    if (currentStep === 4 && d.path === '/var/ship/engine.sh') advanceStep();
  }
});

// For step 3 (grep) — also triggered by button click
// For step 5 (serve) — triggered by button click
// These are "action" steps — clicking the button = doing the step
document.querySelectorAll('.cmd-btn').forEach(function(btn, i) {
  var stepNum = i + 1;
  btn.addEventListener('click', function() {
    // For action steps (1, 3, 5), auto-advance after the command runs
    if (stepNum === currentStep && (stepNum === 1 || stepNum === 3 || stepNum === 5)) {
      setTimeout(function() {
        if (currentStep === stepNum) advanceStep();
      }, 2000);
    }
  });
});
</script>
</body>
</html>`;

export const missionControl: LivingTemplate = {
  id: 'quest-mission-control',
  name: 'Mission Control',
  genre: 'quest',
  level: 'beginner',
  icon: '\u{1F680}',
  desc: 'Fix a broken space station using terminal commands',
  time: '~8 min',
  learns: ['cat', 'echo', 'grep', 'vi', 'serve'],
  guideHtml: missionControlGuide,
  guidePort: 9001,
  setup: [
    'mkdir -p /var/ship/dashboard',
    `cat > /var/ship/status.log << 'EOF'
[CRITICAL] Engine subsystem: OFFLINE
[WARNING]  Navigation: DRIFT DETECTED
[INFO]     Life support: nominal
[INFO]     crew status: 4 members in cryo-sleep, all vitals stable
[CRITICAL] Communications array: NO SIGNAL
[WARNING]  Hull integrity: 94%
EOF`,
    `cat > /var/ship/engine.sh << 'EOF'
#!/bin/sh
# Engine ignition sequence
echo "Checking fule levels..."
echo "Igniting thrusters..."
echo "Engine online."
EOF`,
    `cat > /var/ship/dashboard/index.html << 'EOF'
<!DOCTYPE html>
<html>
<head><title>Station Dashboard</title>
<style>
  body { font-family: monospace; background: #0a0e1a; color: #44ff88; padding: 30px; }
  h1 { color: #3b82f6; border-bottom: 1px solid #1e293b; padding-bottom: 10px; }
  .sys { padding: 8px 0; display: flex; justify-content: space-between; border-bottom: 1px solid #111; }
  .ok { color: #22c55e; }
  .warn { color: #eab308; }
</style></head>
<body>
  <h1>Station Control Dashboard</h1>
  <div class="sys"><span>Engine</span><span class="ok">ONLINE</span></div>
  <div class="sys"><span>Navigation</span><span class="ok">LOCKED</span></div>
  <div class="sys"><span>Life Support</span><span class="ok">NOMINAL</span></div>
  <div class="sys"><span>Hull Integrity</span><span class="warn">94%</span></div>
  <div class="sys"><span>Crew (Cryo)</span><span class="ok">4/4 STABLE</span></div>
  <p style="margin-top:20px;color:#475569;font-size:12px">Last updated: just now</p>
</body>
</html>
EOF`,
  ],
  workDir: '/var/ship',
  checkpoints: [
    { id: 'step-1', verify: { type: 'command-succeeds', command: 'cat /var/ship/status.log' } },
    { id: 'step-2', verify: { type: 'file-contains', path: '/var/ship/coords.txt', pattern: '47.3' } },
    { id: 'step-3', verify: { type: 'command-succeeds', command: 'grep crew /var/ship/status.log' } },
    { id: 'step-4', verify: { type: 'file-contains', path: '/var/ship/engine.sh', pattern: 'fuel' } },
    { id: 'step-5', verify: { type: 'command-succeeds', command: 'serve /var/ship/dashboard 4000' } },
  ],
};

// ─── Mirror: Your Homepage ────────────────────────────────────────────

const homepageGuide = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your Homepage</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #fff;
    color: #1a1a2e;
    padding: 24px;
    line-height: 1.6;
  }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 20px; }
  .form-group { margin-bottom: 16px; }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #475569;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  input, select {
    width: 100%;
    padding: 10px 12px;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.2s;
    background: #fff;
  }
  input:focus, select:focus {
    outline: none;
    border-color: #3b82f6;
  }
  .color-row {
    display: flex;
    gap: 8px;
  }
  .color-swatch {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    cursor: pointer;
    border: 3px solid transparent;
    transition: border-color 0.2s, transform 0.1s;
  }
  .color-swatch:hover { transform: scale(1.1); }
  .color-swatch.selected { border-color: #1a1a2e; }
  .btn {
    display: inline-block;
    background: #3b82f6;
    color: #fff;
    border: none;
    padding: 10px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
    font-family: inherit;
  }
  .btn:hover { background: #2563eb; }
  .btn-outline {
    background: transparent;
    color: #3b82f6;
    border: 2px solid #3b82f6;
  }
  .btn-outline:hover { background: #eff6ff; }
  .step-section {
    border-top: 1px solid #e2e8f0;
    padding-top: 20px;
    margin-top: 20px;
  }
  .step-section.locked { display: none; }
  .step-label {
    font-size: 11px;
    font-weight: 700;
    color: #3b82f6;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .hint {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 12px;
    font-size: 12px;
    color: #64748b;
    margin-top: 12px;
  }
  .hint code {
    background: #e2e8f0;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
  }
  .preview-frame {
    width: 100%;
    height: 200px;
    border: 2px solid #e2e8f0;
    border-radius: 8px;
    margin: 12px 0;
  }
  .success-msg {
    background: #f0fdf4;
    border: 1px solid #22c55e;
    border-radius: 8px;
    padding: 16px;
    text-align: center;
    color: #166534;
    font-size: 13px;
  }
  .success-msg strong { display: block; font-size: 15px; margin-bottom: 4px; }
</style>
</head>
<body>
  <h1>Build Your Homepage</h1>
  <p class="subtitle">Create a personal page that lives on the internet</p>

  <!-- Step 1: Identity -->
  <div id="step1">
    <div class="step-label">Step 1 &mdash; Who are you?</div>

    <div class="form-group">
      <label>Your Name</label>
      <input type="text" id="name-input" placeholder="Alex" />
    </div>

    <div class="form-group">
      <label>What do you love?</label>
      <input type="text" id="interest-input" placeholder="music, coding, skateboarding..." />
    </div>

    <div class="form-group">
      <label>Pick a color</label>
      <div class="color-row" id="colors"></div>
    </div>

    <button class="btn" id="generate-btn">Generate My Page</button>
  </div>

  <!-- Step 2: Customize -->
  <div id="step2" class="step-section locked">
    <div class="step-label">Step 2 &mdash; Make it yours</div>
    <p style="font-size: 13px; color: #475569; margin-bottom: 12px;">
      Your page is live in the terminal! Now edit the HTML to make it your own.
    </p>
    <div class="hint">
      <strong style="color:#1a1a2e">Try this in the terminal:</strong><br>
      <code>vi /tmp/homepage/index.html</code><br>
      Change the tagline, add a section, make it <em>yours</em>.
    </div>
    <div class="cmd-btn" style="display:inline-block;background:#1e293b;border:1px solid #334155;border-radius:4px;padding:6px 12px;margin:10px 0;cursor:pointer;color:#60a5fa;font-family:monospace;font-size:12px"
         onclick="bridge.execInTerminal('vi /tmp/homepage/index.html')">
      vi /tmp/homepage/index.html
    </div>
  </div>

  <!-- Step 3: Publish -->
  <div id="step3" class="step-section locked">
    <div class="step-label">Step 3 &mdash; Share it</div>
    <p style="font-size: 13px; color: #475569; margin-bottom: 12px;">
      Your page is served on port 4001. Publish it with a permanent URL!
    </p>
    <div class="hint">
      <strong style="color:#1a1a2e">Run in terminal:</strong><br>
      <code id="become-cmd">become 4001 yourname</code>
    </div>
    <div class="cmd-btn" style="display:inline-block;background:#1e293b;border:1px solid #334155;border-radius:4px;padding:6px 12px;margin:10px 0;cursor:pointer;color:#60a5fa;font-family:monospace;font-size:12px"
         id="become-btn">
      become 4001
    </div>
  </div>

  <!-- Finale -->
  <div id="finale" class="step-section locked">
    <div class="success-msg">
      <strong>Your homepage is live!</strong>
      You built something real. It persists. You can share it.<br>
      <span style="font-size:11px;color:#64748b;margin-top:8px;display:block">
        Edit anytime: <code>vi /tmp/homepage/index.html</code>
      </span>
    </div>
  </div>

<script>
var bridge = window.__bridge;

var colors = [
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Purple', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Red', hex: '#ef4444' },
  { name: 'Teal', hex: '#14b8a6' },
];

var selectedColor = colors[0].hex;
var colorRow = document.getElementById('colors');
colors.forEach(function(c) {
  var swatch = document.createElement('div');
  swatch.className = 'color-swatch' + (c.hex === selectedColor ? ' selected' : '');
  swatch.style.background = c.hex;
  swatch.onclick = function() {
    selectedColor = c.hex;
    document.querySelectorAll('.color-swatch').forEach(function(s) { s.classList.remove('selected'); });
    swatch.classList.add('selected');
  };
  colorRow.appendChild(swatch);
});

document.getElementById('generate-btn').onclick = function() {
  var name = document.getElementById('name-input').value.trim() || 'Explorer';
  var interests = document.getElementById('interest-input').value.trim() || 'the universe';
  var slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Build the homepage HTML
  var pageHtml = '<!DOCTYPE html>\\n<html>\\n<head>\\n<meta charset="UTF-8">\\n'
    + '<title>' + name + '</title>\\n'
    + '<style>\\n'
    + '  body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 0 20px; background: #fff; }\\n'
    + '  h1 { color: ' + selectedColor + '; font-size: 32px; }\\n'
    + '  .tagline { color: #64748b; font-size: 18px; margin-bottom: 30px; }\\n'
    + '  .section { background: #f8fafc; border-radius: 12px; padding: 20px; margin: 16px 0; }\\n'
    + '  .section h2 { color: ' + selectedColor + '; font-size: 18px; margin-bottom: 8px; }\\n'
    + '  a { color: ' + selectedColor + '; }\\n'
    + '</style>\\n</head>\\n<body>\\n'
    + '  <h1>Hi, I&#39;m ' + name + '</h1>\\n'
    + '  <p class="tagline">I care about ' + interests + '</p>\\n'
    + '  <div class="section">\\n'
    + '    <h2>About Me</h2>\\n'
    + '    <p>Welcome to my corner of the internet. This page was built from scratch in a browser terminal.</p>\\n'
    + '  </div>\\n'
    + '  <div class="section">\\n'
    + '    <h2>My Interests</h2>\\n'
    + '    <p>' + interests + '</p>\\n'
    + '  </div>\\n'
    + '  <p style="color:#94a3b8;font-size:12px;margin-top:30px">Built with Shiro</p>\\n'
    + '</body>\\n</html>';

  // Write the file and serve it
  bridge.execInTerminal("mkdir -p /tmp/homepage");
  setTimeout(function() {
    // Write via heredoc
    bridge.execInTerminal("cat > /tmp/homepage/index.html << 'ENDHTML'\\n" + pageHtml + "\\nENDHTML");
    setTimeout(function() {
      bridge.execInTerminal("serve /tmp/homepage 4001");

      // Show step 2
      document.getElementById('step2').classList.remove('locked');
      document.getElementById('step1').style.opacity = '0.5';
      bridge.completeCheckpoint('generate');

      // Update become command
      document.getElementById('become-cmd').textContent = 'become 4001 ' + slug;
      document.getElementById('become-btn').onclick = function() {
        bridge.execInTerminal('become 4001 ' + slug);
        document.getElementById('finale').classList.remove('locked');
        bridge.completeCheckpoint('publish');
      };
    }, 1500);
  }, 500);
};

// Watch for file edits to show step 3
window.addEventListener('shiro-fs-change', function(e) {
  var d = e.detail;
  if (d.path === '/tmp/homepage/index.html' && d.event === 'write') {
    // They edited the file!
    if (!document.getElementById('step3').classList.contains('locked')) return;
    document.getElementById('step3').classList.remove('locked');
    bridge.completeCheckpoint('customize');
  }
});
</script>
</body>
</html>`;

export const yourHomepage: LivingTemplate = {
  id: 'mirror-homepage',
  name: 'Your Homepage',
  genre: 'mirror',
  level: 'beginner',
  icon: '\u{1F3E0}',
  desc: 'Build a personal page with your name on it',
  time: '~6 min',
  learns: ['cat', 'vi', 'serve', 'become'],
  guideHtml: homepageGuide,
  guidePort: 9002,
  setup: [],
  workDir: '/tmp/homepage',
  checkpoints: [
    { id: 'generate', verify: { type: 'file-exists', path: '/tmp/homepage/index.html' } },
    { id: 'customize', verify: { type: 'file-exists', path: '/tmp/homepage/index.html' } },
    { id: 'publish', verify: { type: 'command-succeeds', command: 'true' } },
  ],
};

// ─── Automator: Tame Your Data ────────────────────────────────────────

const dataGuide = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tame Your Data</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    padding: 20px;
    line-height: 1.6;
  }
  h1 { font-size: 18px; color: #f59e0b; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 12px; margin-bottom: 20px; }
  .data-preview {
    background: #1e293b;
    border-radius: 8px;
    padding: 12px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    overflow-x: auto;
    margin: 12px 0;
    max-height: 180px;
    overflow-y: auto;
    color: #94a3b8;
  }
  .data-preview .header-row { color: #f59e0b; font-weight: bold; }
  .step {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .step.active { border-color: #f59e0b; }
  .step.done { border-color: #22c55e; opacity: 0.7; }
  .step.locked { opacity: 0.35; }
  .step-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
  .step-desc { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
  .cmd-btn {
    display: inline-block;
    background: #0f172a;
    border: 1px solid #475569;
    border-radius: 4px;
    padding: 5px 12px;
    cursor: pointer;
    color: #f59e0b;
    font-family: 'Courier New', monospace;
    font-size: 12px;
  }
  .cmd-btn:hover { background: #1e293b; border-color: #f59e0b; }
  .pipeline {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 8px 0;
    flex-wrap: wrap;
  }
  .pipe-stage {
    background: #334155;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    font-family: monospace;
    color: #f59e0b;
  }
  .pipe-arrow { color: #475569; font-size: 14px; }
  .time-saved {
    background: linear-gradient(135deg, #064e3b, #065f46);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
    margin-top: 16px;
    display: none;
  }
  .time-saved .big { font-size: 28px; font-weight: bold; color: #34d399; }
  .time-saved .small { font-size: 12px; color: #6ee7b7; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Tame Your Data</h1>
  <p class="subtitle">50 employees. Find, filter, and sort in seconds.</p>

  <div class="data-preview" id="data-preview">
    <div class="header-row">name,department,salary,city,start_date</div>
    <div>Loading data...</div>
  </div>

  <div class="step active" id="step-1">
    <div class="step-title">1. See all the data</div>
    <div class="step-desc">First, look at what we're working with.</div>
    <div class="cmd-btn" onclick="run('cat /tmp/data/employees.csv')">cat /tmp/data/employees.csv</div>
  </div>

  <div class="step locked" id="step-2">
    <div class="step-title">2. Find Engineering</div>
    <div class="step-desc">Manually scrolling 50 rows? Or one command?</div>
    <div class="pipeline">
      <span class="pipe-stage">grep</span>
      <span class="pipe-arrow">&rarr;</span>
      <span class="pipe-stage">Engineering rows</span>
    </div>
    <div class="cmd-btn" onclick="run('grep Engineering /tmp/data/employees.csv')">grep Engineering /tmp/data/employees.csv</div>
  </div>

  <div class="step locked" id="step-3">
    <div class="step-title">3. Just the names, sorted</div>
    <div class="step-desc">Chain commands with pipes to build a data pipeline.</div>
    <div class="pipeline">
      <span class="pipe-stage">grep</span>
      <span class="pipe-arrow">|</span>
      <span class="pipe-stage">cut</span>
      <span class="pipe-arrow">|</span>
      <span class="pipe-stage">sort</span>
    </div>
    <div class="cmd-btn" onclick="run('grep Engineering /tmp/data/employees.csv | cut -d, -f1 | sort')">grep Engineering ... | cut -d, -f1 | sort</div>
  </div>

  <div class="step locked" id="step-4">
    <div class="step-title">4. Count per department</div>
    <div class="step-desc">How many people in each department?</div>
    <div class="pipeline">
      <span class="pipe-stage">cut</span>
      <span class="pipe-arrow">|</span>
      <span class="pipe-stage">sort</span>
      <span class="pipe-arrow">|</span>
      <span class="pipe-stage">uniq -c</span>
      <span class="pipe-arrow">|</span>
      <span class="pipe-stage">sort -rn</span>
    </div>
    <div class="cmd-btn" onclick="run('cut -d, -f2 /tmp/data/employees.csv | sort | uniq -c | sort -rn')">cut -d, -f2 ... | sort | uniq -c | sort -rn</div>
  </div>

  <div class="step locked" id="step-5">
    <div class="step-title">5. Save a report</div>
    <div class="step-desc">Redirect output to a file. Now you have a permanent report.</div>
    <div class="cmd-btn" onclick="run('grep Engineering /tmp/data/employees.csv | cut -d, -f1,3 | sort > /tmp/data/eng-report.csv && cat /tmp/data/eng-report.csv')">... | sort > /tmp/data/eng-report.csv</div>
  </div>

  <div class="time-saved" id="time-saved">
    <div class="big">0.3 seconds</div>
    <div class="small">That task takes 45 minutes by hand.<br>You just automated it.</div>
  </div>

<script>
var bridge = window.__bridge;
var currentStep = 1;

function run(cmd) {
  bridge.execInTerminal(cmd);
  setTimeout(function() { advance(); }, 2000);
}

function advance() {
  var el = document.getElementById('step-' + currentStep);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
  currentStep++;
  bridge.completeCheckpoint('step-' + (currentStep - 1));

  if (currentStep <= 5) {
    var next = document.getElementById('step-' + currentStep);
    if (next) { next.classList.remove('locked'); next.classList.add('active'); }
  }
  if (currentStep > 5) {
    document.getElementById('time-saved').style.display = 'block';
  }
}

// Populate preview after a moment
setTimeout(function() {
  var lines = [
    'Alice Chen,Engineering,95000,Seattle,2023-01-15',
    'Bob Garcia,Marketing,72000,Austin,2022-06-01',
    'Carol Kim,Engineering,102000,Seattle,2021-03-20',
    '... (50 rows total)'
  ];
  var preview = document.getElementById('data-preview');
  preview.innerHTML = '<div class="header-row">name,department,salary,city,start_date</div>'
    + lines.map(function(l) { return '<div>' + l + '</div>'; }).join('');
}, 500);
</script>
</body>
</html>`;

// Generate 50 employee rows
function generateCSV(): string {
  const firstNames = ['Alice','Bob','Carol','Dave','Eve','Frank','Grace','Hank','Iris','Jack',
    'Kate','Leo','Mia','Nick','Olivia','Pete','Quinn','Rosa','Sam','Tina',
    'Uma','Vic','Wendy','Xander','Yuki','Zara','Amit','Beth','Cody','Diana'];
  const lastNames = ['Chen','Garcia','Kim','Lee','Park','Singh','Patel','Brown','Wilson','Taylor',
    'Davis','Moore','Clark','Hall','Young','King','Wright','Lopez','Hill','Scott'];
  const depts = ['Engineering','Marketing','Sales','Design','Finance','Operations','Engineering','Engineering','Sales','Design'];
  const cities = ['Seattle','Austin','Denver','Portland','Chicago','Boston','Seattle','Austin','Denver','Portland'];

  let csv = 'name,department,salary,city,start_date\n';
  for (let i = 0; i < 50; i++) {
    const first = firstNames[i % firstNames.length];
    const last = lastNames[i % lastNames.length];
    const dept = depts[i % depts.length];
    const salary = 60000 + Math.floor((i * 1777) % 50000);
    const city = cities[i % cities.length];
    const year = 2020 + (i % 5);
    const month = String(1 + (i % 12)).padStart(2, '0');
    const day = String(1 + (i % 28)).padStart(2, '0');
    csv += `${first} ${last},${dept},${salary},${city},${year}-${month}-${day}\n`;
  }
  return csv;
}

export const tameYourData: LivingTemplate = {
  id: 'automator-data',
  name: 'Tame Your Data',
  genre: 'automator',
  level: 'beginner',
  icon: '\u{1F4CA}',
  desc: 'Filter 50 rows in 0.3 seconds instead of 45 minutes',
  time: '~5 min',
  learns: ['grep', 'cut', 'sort', 'uniq', 'pipes', 'redirects'],
  guideHtml: dataGuide,
  guidePort: 9003,
  setup: [
    'mkdir -p /tmp/data',
  ],
  workDir: '/tmp/data',
  checkpoints: [
    { id: 'step-1', verify: { type: 'command-succeeds', command: 'cat /tmp/data/employees.csv' } },
    { id: 'step-2', verify: { type: 'command-succeeds', command: 'grep Engineering /tmp/data/employees.csv' } },
    { id: 'step-3', verify: { type: 'command-succeeds', command: 'true' } },
    { id: 'step-4', verify: { type: 'command-succeeds', command: 'true' } },
    { id: 'step-5', verify: { type: 'file-exists', path: '/tmp/data/eng-report.csv' } },
  ],
};

// We need to write the CSV in the runner since it's generated
// Override setup to include a write command for the CSV
tameYourData.setup.push(
  `cat > /tmp/data/employees.csv << 'EOF'\n${generateCSV()}EOF`
);

// ─── Canvas: Code as Art ──────────────────────────────────────────────

const artGuide = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code as Art</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f0f1a;
    color: #e2e8f0;
    padding: 20px;
    line-height: 1.6;
  }
  h1 { font-size: 18px; color: #c084fc; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 12px; margin-bottom: 16px; }
  canvas {
    display: block;
    width: 100%;
    border-radius: 8px;
    margin: 12px 0;
    background: #000;
  }
  .controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 12px 0;
  }
  .control {
    background: #1e293b;
    border-radius: 8px;
    padding: 10px;
  }
  .control label {
    display: block;
    font-size: 10px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .control input[type=range] {
    width: 100%;
    accent-color: #c084fc;
  }
  .control .value {
    font-size: 18px;
    font-weight: bold;
    color: #c084fc;
    font-family: monospace;
  }
  .step {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 14px;
    margin: 10px 0;
  }
  .step-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .step-desc { font-size: 12px; color: #94a3b8; }
  .cmd-btn {
    display: inline-block;
    background: #0f172a;
    border: 1px solid #475569;
    border-radius: 4px;
    padding: 5px 10px;
    cursor: pointer;
    color: #c084fc;
    font-family: monospace;
    font-size: 12px;
    margin-top: 8px;
  }
  .cmd-btn:hover { border-color: #c084fc; }
  .finale {
    text-align: center;
    padding: 16px;
    display: none;
  }
  .finale p { color: #94a3b8; font-size: 12px; }
</style>
</head>
<body>
  <h1>Code as Art</h1>
  <p class="subtitle">Numbers become beauty. Change a value, change the art.</p>

  <canvas id="canvas" width="600" height="300"></canvas>

  <div class="controls">
    <div class="control">
      <label>Spiral Count</label>
      <div class="value" id="v-spirals">7</div>
      <input type="range" min="1" max="30" value="7" id="spirals" />
    </div>
    <div class="control">
      <label>Color Speed</label>
      <div class="value" id="v-speed">3</div>
      <input type="range" min="1" max="10" value="3" id="speed" />
    </div>
    <div class="control">
      <label>Point Size</label>
      <div class="value" id="v-size">2</div>
      <input type="range" min="1" max="8" value="2" id="size" />
    </div>
    <div class="control">
      <label>Brightness</label>
      <div class="value" id="v-bright">60</div>
      <input type="range" min="20" max="100" value="60" id="bright" />
    </div>
  </div>

  <div class="step">
    <div class="step-title">Now edit the code</div>
    <div class="step-desc">The art is generated by <code>/tmp/art/spiral.js</code>. Open it and change the numbers.</div>
    <div class="cmd-btn" onclick="bridge.execInTerminal('vi /tmp/art/spiral.js')">vi /tmp/art/spiral.js</div>
  </div>

  <div class="step">
    <div class="step-title">Export your creation</div>
    <div class="step-desc">Capture your unique art as a GIF to share.</div>
    <div class="cmd-btn" onclick="bridge.execInTerminal('seed gif')">seed gif</div>
  </div>

  <div class="finale" id="finale">
    <p>You painted with numbers. Code is a creative medium.</p>
  </div>

<script>
var bridge = window.__bridge;
var canvas = document.getElementById('canvas');
var ctx = canvas.getContext('2d');

var params = { spirals: 7, speed: 3, size: 2, bright: 60 };

function draw() {
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  var t = Date.now() * 0.001;
  var cx = canvas.width / 2;
  var cy = canvas.height / 2;

  for (var s = 0; s < params.spirals; s++) {
    var offset = (s / params.spirals) * Math.PI * 2;
    for (var i = 0; i < 80; i++) {
      var angle = i * 0.15 + t + offset;
      var r = i * 1.8;
      var x = cx + Math.cos(angle) * r;
      var y = cy + Math.sin(angle) * r;
      var hue = (i * params.speed + s * 40 + t * 30) % 360;
      ctx.fillStyle = 'hsl(' + hue + ',' + params.bright + '%,50%)';
      ctx.beginPath();
      ctx.arc(x, y, params.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  requestAnimationFrame(draw);
}

// Wire up sliders
['spirals','speed','size','bright'].forEach(function(key) {
  var slider = document.getElementById(key);
  var display = document.getElementById('v-' + key);
  slider.oninput = function() {
    params[key] = parseInt(slider.value);
    display.textContent = slider.value;
  };
});

draw();

// Watch for file changes (user edited spiral.js)
window.addEventListener('shiro-fs-change', function(e) {
  if (e.detail.path === '/tmp/art/spiral.js') {
    bridge.completeCheckpoint('edit-code');
    document.getElementById('finale').style.display = 'block';
  }
});
</script>
</body>
</html>`;

export const codeAsArt: LivingTemplate = {
  id: 'canvas-art',
  name: 'Code as Art',
  genre: 'canvas',
  level: 'beginner',
  icon: '\u{1F3A8}',
  desc: 'Paint with numbers — generative spirals you control',
  time: '~5 min',
  learns: ['vi', 'editing code', 'seed gif'],
  guideHtml: artGuide,
  guidePort: 9004,
  setup: [
    'mkdir -p /tmp/art',
    `cat > /tmp/art/spiral.js << 'EOF'
// Generative Spiral Art
// Change these numbers and see what happens!

var SPIRALS = 7;       // try 3, 12, 23
var COLOR_SPEED = 3;   // how fast colors shift
var POINT_SIZE = 2;    // dot radius
var BRIGHTNESS = 60;   // color brightness %

// The rendering loop
function draw(ctx, t) {
  ctx.fillStyle = 'rgba(0,0,0,0.05)';
  ctx.fillRect(0, 0, 600, 300);

  var cx = 300, cy = 150;
  for (var s = 0; s < SPIRALS; s++) {
    var offset = (s / SPIRALS) * Math.PI * 2;
    for (var i = 0; i < 80; i++) {
      var angle = i * 0.15 + t + offset;
      var r = i * 1.8;
      var x = cx + Math.cos(angle) * r;
      var y = cy + Math.sin(angle) * r;
      var hue = (i * COLOR_SPEED + s * 40 + t * 30) % 360;
      ctx.fillStyle = 'hsl(' + hue + ',' + BRIGHTNESS + '%,50%)';
      ctx.beginPath();
      ctx.arc(x, y, POINT_SIZE, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
EOF`,
  ],
  workDir: '/tmp/art',
  checkpoints: [
    { id: 'edit-code', verify: { type: 'file-exists', path: '/tmp/art/spiral.js' } },
  ],
};

// ─── Collaborator: AI Copilot ─────────────────────────────────────────

const copilotGuide = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Copilot</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #fff;
    color: #1a1a2e;
    padding: 24px;
    line-height: 1.6;
  }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }
  .step {
    border-left: 3px solid #e2e8f0;
    padding: 16px 16px 16px 20px;
    margin-bottom: 4px;
    transition: border-color 0.3s;
  }
  .step.active { border-color: #8b5cf6; }
  .step.done { border-color: #22c55e; }
  .step-label {
    font-size: 10px;
    font-weight: 700;
    color: #8b5cf6;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 6px;
  }
  .step.done .step-label { color: #22c55e; }
  .step-title { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
  .step-desc { font-size: 13px; color: #64748b; margin-bottom: 10px; }
  .cmd-btn {
    display: inline-block;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    padding: 8px 14px;
    cursor: pointer;
    color: #8b5cf6;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    transition: all 0.2s;
  }
  .cmd-btn:hover { background: #ede9fe; border-color: #8b5cf6; }
  .callout {
    background: #faf5ff;
    border: 1px solid #e9d5ff;
    border-radius: 8px;
    padding: 12px 16px;
    margin: 12px 0;
    font-size: 12px;
    color: #6b21a8;
  }
  .locked { opacity: 0.3; pointer-events: none; }
  .finale {
    text-align: center;
    padding: 20px;
    display: none;
    background: #f0fdf4;
    border-radius: 12px;
    margin-top: 16px;
  }
  .finale h2 { color: #166534; font-size: 16px; margin-bottom: 8px; }
  .finale p { color: #64748b; font-size: 12px; }
</style>
</head>
<body>
  <h1>Your AI Copilot</h1>
  <p class="subtitle">Direct an AI to build, then understand and modify what it wrote.</p>

  <div class="step active" id="step-1">
    <div class="step-label">Step 1 &mdash; Tell Claude what to build</div>
    <div class="step-title">Build something with one sentence</div>
    <div class="step-desc">Claude Code can build full apps from a description. Try this:</div>
    <div class="cmd-btn" onclick="run1()">sc -p "build a to-do app with dark theme, save to /tmp/todo"</div>
    <div class="callout" style="margin-top:10px">
      Or type your own request! <code>sc -p "build me a [your idea]"</code>
    </div>
  </div>

  <div class="step locked" id="step-2">
    <div class="step-label">Step 2 &mdash; See what it built</div>
    <div class="step-title">Read the code Claude wrote</div>
    <div class="step-desc">Look at the files Claude created. Can you find the function that adds a new item?</div>
    <div class="cmd-btn" onclick="run2()">ls /tmp/todo && cat /tmp/todo/index.html</div>
  </div>

  <div class="step locked" id="step-3">
    <div class="step-label">Step 3 &mdash; Modify it yourself</div>
    <div class="step-title">Change one line</div>
    <div class="step-desc">Open the file and change something — a color, a label, anything. You are not just a consumer of AI. You are someone who can direct it.</div>
    <div class="cmd-btn" onclick="run3()">vi /tmp/todo/index.html</div>
  </div>

  <div class="step locked" id="step-4">
    <div class="step-label">Step 4 &mdash; See it live</div>
    <div class="step-title">Serve your creation</div>
    <div class="step-desc">Launch your modified app and see it running.</div>
    <div class="cmd-btn" onclick="run4()">serve /tmp/todo 4002</div>
  </div>

  <div class="finale" id="finale">
    <h2>You directed AI, understood code, and modified it</h2>
    <p>That's three skills most people think they can't learn.<br>You just did all three in minutes.</p>
  </div>

<script>
var bridge = window.__bridge;
var currentStep = 1;

function advance() {
  var el = document.getElementById('step-' + currentStep);
  if (el) { el.classList.remove('active'); el.classList.add('done'); }
  bridge.completeCheckpoint('step-' + currentStep);
  currentStep++;
  if (currentStep <= 4) {
    var next = document.getElementById('step-' + currentStep);
    if (next) { next.classList.remove('locked'); next.classList.add('active'); }
  }
  if (currentStep > 4) {
    document.getElementById('finale').style.display = 'block';
  }
}

function run1() {
  bridge.execInTerminal('sc -p "build a simple to-do app with dark theme and save it to /tmp/todo"');
  // Wait for Claude to finish (can take a while)
  var check = setInterval(function() {
    bridge.checkFile('/tmp/todo/index.html');
  }, 5000);
  window.addEventListener('shiro-check-result', function handler(e) {
    if (e.detail.passed && e.detail.path === '/tmp/todo/index.html' && currentStep === 1) {
      clearInterval(check);
      window.removeEventListener('shiro-check-result', handler);
      advance();
    }
  });
}

function run2() {
  bridge.execInTerminal('ls /tmp/todo && echo "---" && cat /tmp/todo/index.html | head -40');
  setTimeout(function() { if (currentStep === 2) advance(); }, 3000);
}

function run3() {
  bridge.execInTerminal('vi /tmp/todo/index.html');
  // Watch for file save
  window.addEventListener('shiro-fs-change', function handler(e) {
    if (e.detail.path === '/tmp/todo/index.html' && currentStep === 3) {
      window.removeEventListener('shiro-fs-change', handler);
      advance();
    }
  });
}

function run4() {
  bridge.execInTerminal('serve /tmp/todo 4002');
  setTimeout(function() { if (currentStep === 4) advance(); }, 2000);
}
</script>
</body>
</html>`;

export const aiCopilot: LivingTemplate = {
  id: 'collaborator-copilot',
  name: 'AI Copilot',
  genre: 'collaborator',
  level: 'intermediate',
  icon: '\u{1F916}',
  desc: 'Direct AI to build, then read and modify the code',
  time: '~10 min',
  learns: ['sc', 'cat', 'vi', 'serve', 'reading code'],
  guideHtml: copilotGuide,
  guidePort: 9005,
  setup: [
    'mkdir -p /tmp/todo',
  ],
  workDir: '/tmp/todo',
  checkpoints: [
    { id: 'step-1', verify: { type: 'file-exists', path: '/tmp/todo/index.html' } },
    { id: 'step-2', verify: { type: 'command-succeeds', command: 'cat /tmp/todo/index.html' } },
    { id: 'step-3', verify: { type: 'file-exists', path: '/tmp/todo/index.html' } },
    { id: 'step-4', verify: { type: 'command-succeeds', command: 'true' } },
  ],
};

// ─── Export all templates ─────────────────────────────────────────────

export const livingTemplates: LivingTemplate[] = [
  missionControl,
  yourHomepage,
  tameYourData,
  codeAsArt,
  aiCopilot,
];
