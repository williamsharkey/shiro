/**
 * Template palette — educational lessons for young programmers.
 * Each template explains concepts, creates files, runs code, and suggests next steps.
 */

// ANSI color codes (actual ESC bytes for terminal rendering)
const CY = '\x1b[1;36m';  // bold cyan — headings
const GN = '\x1b[32m';    // green — steps
const DM = '\x1b[90m';    // dim gray — explanations
const YL = '\x1b[1;33m';  // bold yellow
const BD = '\x1b[1m';     // bold
const RS = '\x1b[0m';     // reset

export interface Template {
  name: string;
  desc: string;
  icon: string;
  cmd: string;
  splitPort?: number;
  level: 'beginner' | 'intermediate' | 'advanced';
}

export interface TemplateCategory {
  name: string;
  templates: Template[];
}

/** Exported for testing */
export const categories: TemplateCategory[] = [
  {
    name: 'Web',
    templates: [
      {
        name: 'HTML Page',
        desc: 'Create and serve a web page',
        icon: '\u{1F310}',
        level: 'beginner',
        splitPort: 3000,
        cmd: `echo "${CY}--- Lesson: HTML Basics ---${RS}"
echo ""
echo "${DM}Create a web page and see it live. Edit the file to see changes.${RS}"
echo ""
echo "${GN}> Creating /tmp/mypage/index.html${RS}"
mkdir -p /tmp/mypage && cat > /tmp/mypage/index.html << 'ENDHTML'
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>My First Page</title>
  <style>
    /* CSS styles control how things look */
    body {
      font-family: system-ui, sans-serif;
      max-width: 600px;
      margin: 40px auto;
      padding: 0 20px;
      background: #fff;
      color: #333;
    }
    h1 { color: #2563eb; }
    .card {
      background: #f0f4ff;
      border-radius: 8px;
      padding: 16px;
      margin: 16px 0;
    }
    button {
      background: #2563eb;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <!-- HTML elements are the building blocks of web pages -->
  <h1>Hello from Shiro!</h1>
  <p>This page is served from the browser's virtual filesystem.</p>

  <div class="card">
    <h3>How it works</h3>
    <p>The file <code>/tmp/mypage/index.html</code> is served
    by Shiro's virtual web server on port 3000.</p>
  </div>

  <!-- onclick runs JavaScript when the button is clicked -->
  <button onclick="document.getElementById('msg').textContent='You clicked! '+new Date().toLocaleTimeString()">
    Click me
  </button>
  <p id="msg"></p>
</body>
</html>
ENDHTML
echo ""
echo "${GN}> Serving on port 3000${RS}"
serve /tmp/mypage 3000
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  vi /tmp/mypage/index.html   (edit the page)${RS}"
echo "${DM}  Change the CSS colors in the style block${RS}"
echo "${DM}  Add a <ul> list or <img> tag${RS}"`,
      },
      {
        name: 'Node.js Server',
        desc: 'Build a JSON API server',
        icon: '\u{1F7E9}',
        level: 'intermediate',
        splitPort: 3001,
        cmd: `echo "${CY}--- Lesson: Node.js Server ---${RS}"
echo ""
echo "${DM}Build an API with Express.js. Learn routes, requests, and responses.${RS}"
echo ""
echo "${GN}> Creating /tmp/myapi/server.js${RS}"
mkdir -p /tmp/myapi && cat > /tmp/myapi/server.js << 'ENDJS'
/* Express is a web framework for Node.js.
 * "Routes" map URL paths to handler functions.
 * Each handler receives (req, res) — the request and response.
 */
var express = require('express');
var fs = require('fs');
var app = express();

/* GET / — serve the HTML dashboard */
app.get('/', function(req, res) {
  var html = fs.readFileSync('/tmp/myapi/index.html', 'utf8');
  res.send(html);
});

/* GET /api/time — returns the current time as JSON */
app.get('/api/time', function(req, res) {
  res.json({ time: new Date().toISOString(), unix: Date.now() });
});

/* GET /api/echo?msg=hello — echoes back your message */
app.get('/api/echo', function(req, res) {
  var msg = req.query.msg || 'nothing';
  res.json({ you_said: msg, length: msg.length });
});

/* GET /api/random — returns a random number 0-99 */
app.get('/api/random', function(req, res) {
  res.json({ number: Math.floor(Math.random() * 100) });
});

/* Start listening — this registers with Shiro's virtual server */
app.listen(3001, function() { console.log('Server running on port 3001'); });
ENDJS
echo "${GN}> Creating /tmp/myapi/index.html${RS}"
cat > /tmp/myapi/index.html << 'ENDHTML'
<!DOCTYPE html>
<html>
<head>
  <title>My API</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #fff; }
    h1 { color: #16a34a; }
    .endpoint { background: #f0fdf4; border-radius: 8px; padding: 12px 16px; margin: 12px 0; cursor: pointer; }
    .endpoint:hover { background: #dcfce7; }
    .endpoint code { color: #166534; font-weight: bold; }
    #result { background: #1e293b; color: #4ade80; padding: 12px; border-radius: 6px; font-family: monospace; white-space: pre; min-height: 2em; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>API Dashboard</h1>
  <p>Click an endpoint to call it:</p>

  <div class="endpoint" onclick="callApi('/api/time')">
    <code>GET /api/time</code> &mdash; Current timestamp
  </div>
  <div class="endpoint" onclick="callApi('/api/echo?msg=hello')">
    <code>GET /api/echo?msg=hello</code> &mdash; Echo service
  </div>
  <div class="endpoint" onclick="callApi('/api/random')">
    <code>GET /api/random</code> &mdash; Random number
  </div>

  <div id="result">Click an endpoint above...</div>

  <script>
    function callApi(url) {
      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          document.getElementById('result').textContent = JSON.stringify(data, null, 2);
        });
    }
  </script>
</body>
</html>
ENDHTML
echo ""
echo "${GN}> Starting server on port 3001${RS}"
node /tmp/myapi/server.js
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  vi /tmp/myapi/server.js   (add a new route)${RS}"
echo "${DM}  Try: app.get('/api/greet', function(req, res) {${RS}"
echo "${DM}    res.json({ hello: req.query.name || 'world' });${RS}"
echo "${DM}  });${RS}"`,
      },
      {
        name: 'React App',
        desc: 'Components and state',
        icon: '\u269B\uFE0F',
        level: 'intermediate',
        splitPort: 3002,
        cmd: `echo "${CY}--- Lesson: React ---${RS}"
echo ""
echo "${DM}Build interactive UIs with components and state.${RS}"
echo "${DM}React.createElement(tag, props, ...children) is what JSX compiles to.${RS}"
echo ""
echo "${GN}> Creating /tmp/myreact/index.html${RS}"
mkdir -p /tmp/myreact && cat > /tmp/myreact/index.html << 'ENDHTML'
<!DOCTYPE html>
<html>
<head>
  <title>React App</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 40px auto; padding: 0 20px; background: #fff; }
    h1 { color: #61dafb; }
    .counter { font-size: 48px; text-align: center; margin: 20px 0; }
    button { background: #61dafb; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin: 4px; font-size: 14px; }
    button:hover { background: #4fc3f7; }
    .info { background: #f0f8ff; padding: 12px; border-radius: 8px; margin: 16px 0; font-size: 13px; color: #555; }
  </style>
</head>
<body>
  <div id="root">Loading React from CDN...</div>
  <script>
    /* A component is a function that returns UI.
     * React.createElement(type, props, ...children) builds the element tree.
     * useState(initial) returns [value, setter] for reactive state. */
    var e = React.createElement;

    function Counter() {
      var state = React.useState(0);
      var count = state[0];
      var setCount = state[1];

      return e('div', null,
        e('h1', null, 'React Counter'),
        e('div', { className: 'info' },
          'Components are functions. State makes them interactive. ',
          'This is what JSX compiles to behind the scenes.'
        ),
        e('div', { className: 'counter' }, count),
        e('div', { style: { textAlign: 'center' } },
          e('button', { onClick: function() { setCount(count - 1); } }, '-1'),
          e('button', { onClick: function() { setCount(0); } }, 'Reset'),
          e('button', { onClick: function() { setCount(count + 1); } }, '+1')
        )
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(e(Counter));
  </script>
</body>
</html>
ENDHTML
echo ""
echo "${GN}> Serving on port 3002${RS}"
serve /tmp/myreact 3002
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  vi /tmp/myreact/index.html   (edit the component)${RS}"
echo "${DM}  Add a second component (function that returns createElement)${RS}"
echo "${DM}  Try adding a text input with onChange${RS}"`,
      },
      {
        name: 'React + Routing',
        desc: 'Multi-page app with navigation',
        icon: '\u{1F500}',
        level: 'advanced',
        splitPort: 3003,
        cmd: `echo "${CY}--- Lesson: React Routing ---${RS}"
echo ""
echo "${DM}Build a multi-page app with hash-based navigation.${RS}"
echo ""
echo "${GN}> Creating /tmp/myapp/index.html${RS}"
mkdir -p /tmp/myapp && cat > /tmp/myapp/index.html << 'ENDHTML'
<!DOCTYPE html>
<html>
<head>
  <title>React Router</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 40px auto; padding: 0 20px; background: #fff; }
    nav { display: flex; gap: 16px; padding: 12px 0; border-bottom: 2px solid #eee; margin-bottom: 20px; }
    nav a { color: #2563eb; text-decoration: none; font-weight: 500; }
    nav a:hover { text-decoration: underline; }
    h1 { color: #2563eb; }
    .card { background: #f0f4ff; padding: 16px; border-radius: 8px; margin: 12px 0; }
    button { background: #2563eb; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin: 4px; }
    input { padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
  </style>
</head>
<body>
  <div id="root">Loading...</div>
  <script>
    var e = React.createElement;

    /* Each page is a component (function returning UI) */
    function Home() {
      return e('div', null,
        e('h1', null, 'Home'),
        e('div', { className: 'card' },
          e('p', null, 'This app uses hash-based routing: #/page'),
          e('p', null, 'The URL hash changes, React re-renders the right page.')
        )
      );
    }

    function CounterPage() {
      var s = React.useState(0);
      return e('div', null,
        e('h1', null, 'Counter'),
        e('p', { style: { fontSize: '48px', textAlign: 'center' } }, s[0]),
        e('div', { style: { textAlign: 'center' } },
          e('button', { onClick: function() { s[1](s[0] + 1); } }, '+1'),
          e('button', { onClick: function() { s[1](s[0] - 1); } }, '-1')
        )
      );
    }

    function About() {
      return e('div', null,
        e('h1', null, 'About'),
        e('div', { className: 'card' },
          e('p', null, 'Built with React loaded from CDN.'),
          e('p', null, 'No build step needed.'),
          e('p', null, 'Edit /tmp/myapp/index.html to add pages!')
        )
      );
    }

    /* Router: maps hash paths to page components */
    var routes = { '/': Home, '/counter': CounterPage, '/about': About };

    function App() {
      var s = React.useState(location.hash.slice(1) || '/');
      React.useEffect(function() {
        var fn = function() { s[1](location.hash.slice(1) || '/'); };
        window.addEventListener('hashchange', fn);
        return function() { window.removeEventListener('hashchange', fn); };
      }, []);
      var Page = routes[s[0]] || Home;
      return e('div', null,
        e('nav', null,
          e('a', { href: '#/' }, 'Home'),
          e('a', { href: '#/counter' }, 'Counter'),
          e('a', { href: '#/about' }, 'About')
        ),
        e(Page)
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(e(App));
  </script>
</body>
</html>
ENDHTML
echo ""
echo "${GN}> Serving on port 3003${RS}"
serve /tmp/myapp 3003
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  vi /tmp/myapp/index.html   (add a new page)${RS}"
echo "${DM}  Add a route: '/todos': TodoPage${RS}"
echo "${DM}  Try useEffect for data fetching${RS}"`,
      },
      {
        name: 'Full-Stack API',
        desc: 'Express + SQLite with live preview',
        icon: '\u{1F4E1}',
        level: 'advanced',
        splitPort: 3004,
        cmd: `echo "${CY}--- Full-Stack API: Express + SQLite ---${RS}"
echo ""
echo "${DM}A complete API server with a database and dashboard UI.${RS}"
echo "${DM}Express handles HTTP routes. SQLite stores data persistently.${RS}"
echo ""
echo "${GN}> Creating /tmp/fullstack/server.js${RS}"
mkdir -p /tmp/fullstack && cat > /tmp/fullstack/server.js << 'ENDJS'
var express = require('express');
var fs = require('fs');
var Database = require('better-sqlite3');
var app = express();

app.use(express.json());

/* Initialize database */
var db = new Database(':memory:');

async function main() {
  await db.ready;

  /* Create notes table */
  await db.prepare('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, created_at TEXT)');

  /* Seed starter notes if empty */
  var count = await db.prepare('SELECT COUNT(*) as n FROM notes');
  if (count[0].n === 0) {
    await db.prepare("INSERT INTO notes (title, body, created_at) VALUES ('Welcome', 'This is your first note!', datetime('now'))");
    await db.prepare("INSERT INTO notes (title, body, created_at) VALUES ('Shopping List', 'Milk, eggs, bread', datetime('now'))");
    await db.prepare("INSERT INTO notes (title, body, created_at) VALUES ('Ideas', 'Build something awesome with Shiro', datetime('now'))");
  }

  /* GET /api/notes — list all notes */
  app.get('/api/notes', async function(req, res) {
    var rows = await db.prepare('SELECT * FROM notes ORDER BY id DESC');
    res.json(rows);
  });

  /* POST /api/notes — create a note */
  app.post('/api/notes', async function(req, res) {
    var title = req.body.title || 'Untitled';
    var body = req.body.body || '';
    await db.prepare("INSERT INTO notes (title, body, created_at) VALUES ('" + title.replace(/'/g, "''") + "', '" + body.replace(/'/g, "''") + "', datetime('now'))");
    res.json({ ok: true });
  });

  /* GET /api/stats — database statistics */
  app.get('/api/stats', async function(req, res) {
    var total = await db.prepare('SELECT COUNT(*) as n FROM notes');
    var latest = await db.prepare('SELECT created_at FROM notes ORDER BY id DESC LIMIT 1');
    res.json({ total: total[0].n, latest: latest[0] ? latest[0].created_at : null });
  });

  /* Serve the dashboard */
  app.get('/', function(req, res) {
    var html = fs.readFileSync('/tmp/fullstack/index.html', 'utf8');
    res.send(html);
  });

  app.listen(3004, function() { console.log('Full-stack server on port 3004'); });
}

main();
ENDJS
echo "${GN}> Creating /tmp/fullstack/index.html${RS}"
cat > /tmp/fullstack/index.html << 'ENDHTML'
<!DOCTYPE html>
<html>
<head>
  <title>Notes API</title>
  <style>
    body { font-family: system-ui; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #fff; color: #333; }
    h1 { color: #7c3aed; }
    .stats { display: flex; gap: 16px; margin: 16px 0; }
    .stat { background: #f5f3ff; padding: 12px 16px; border-radius: 8px; flex: 1; text-align: center; }
    .stat .n { font-size: 28px; font-weight: bold; color: #7c3aed; }
    .stat .label { font-size: 11px; color: #888; text-transform: uppercase; }
    .note { background: #faf5ff; border-radius: 8px; padding: 12px 16px; margin: 8px 0; }
    .note h3 { margin: 0 0 4px; color: #6d28d9; font-size: 14px; }
    .note p { margin: 0; font-size: 13px; color: #555; }
    .note .time { font-size: 10px; color: #aaa; margin-top: 4px; }
    .form { background: #f9fafb; border-radius: 8px; padding: 16px; margin: 16px 0; }
    input, textarea { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; box-sizing: border-box; margin-bottom: 8px; }
    textarea { height: 60px; resize: vertical; }
    button { background: #7c3aed; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    button:hover { background: #6d28d9; }
  </style>
</head>
<body>
  <h1>Notes Dashboard</h1>
  <div class="stats" id="stats"></div>
  <div class="form">
    <input id="title" placeholder="Note title..." />
    <textarea id="body" placeholder="Note body..."></textarea>
    <button onclick="addNote()">Add Note</button>
  </div>
  <div id="notes"></div>
  <script>
    function loadStats() {
      fetch('/api/stats').then(function(r){return r.json()}).then(function(s) {
        document.getElementById('stats').innerHTML =
          '<div class="stat"><div class="n">'+s.total+'</div><div class="label">Notes</div></div>' +
          '<div class="stat"><div class="n">'+(s.latest||'-')+'</div><div class="label">Latest</div></div>';
      });
    }
    function loadNotes() {
      fetch('/api/notes').then(function(r){return r.json()}).then(function(notes) {
        var html = '';
        for (var i = 0; i < notes.length; i++) {
          html += '<div class="note"><h3>'+notes[i].title+'</h3><p>'+notes[i].body+'</p><div class="time">'+notes[i].created_at+'</div></div>';
        }
        document.getElementById('notes').innerHTML = html || '<p>No notes yet.</p>';
      });
    }
    function addNote() {
      var t = document.getElementById('title');
      var b = document.getElementById('body');
      fetch('/api/notes', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title: t.value, body: b.value})
      }).then(function() { t.value=''; b.value=''; loadStats(); loadNotes(); });
    }
    loadStats();
    loadNotes();
  </script>
</body>
</html>
ENDHTML
echo ""
echo "${GN}> Starting server on port 3004${RS}"
node /tmp/fullstack/server.js
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  curl localhost:3004/api/stats${RS}"
echo "${DM}  Add a DELETE /api/notes/:id endpoint${RS}"
echo "${DM}  vi /tmp/fullstack/index.html  (style the dashboard)${RS}"`,
      },
    ],
  },
  {
    name: 'Languages',
    templates: [
      {
        name: 'Python',
        desc: 'Variables, loops, and functions',
        icon: '\u{1F40D}',
        level: 'beginner',
        cmd: `echo "${CY}--- Lesson: Python ---${RS}"
echo ""
echo "${DM}Learn Python: variables, data types, loops, and functions.${RS}"
echo ""
echo "${GN}> Creating /tmp/lesson.py${RS}"
cat > /tmp/lesson.py << 'ENDPY'
import sys
import math

print("Python " + sys.version.split()[0] + " running in the browser!")
print()

# --- Variables and types ---
name = "Shiro"
age = 1
pi = 3.14159
print("Variables: name=" + name + ", age=" + str(age) + ", pi=" + str(pi))
print()

# --- Lists and list comprehensions ---
numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
squares = [x**2 for x in numbers]
evens = [x for x in numbers if x % 2 == 0]
print("Numbers: " + str(numbers))
print("Squares: " + str(squares))
print("Evens:   " + str(evens))
print()

# --- Dictionaries ---
scores = {"Alice": 95, "Bob": 82, "Carol": 91, "Dave": 78, "Eve": 88}
print("Test scores:")
for name in sorted(scores, key=lambda k: -scores[k]):
    score = scores[name]
    bar = "#" * (score // 5)
    print("  " + name.ljust(8) + str(score).rjust(3) + " " + bar)
print()

# --- Functions ---
def fibonacci(n):
    """Generate first n Fibonacci numbers"""
    a, b = 0, 1
    result = []
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result

print("Fibonacci: " + str(fibonacci(10)))
print()

# --- ASCII sine wave ---
print("Sine wave:")
for i in range(30):
    x = i * math.pi / 8
    y = int((math.sin(x) + 1) * 15)
    print(" " * y + "*")
ENDPY
echo ""
echo "${GN}> Running...${RS}"
python /tmp/lesson.py
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  vi /tmp/lesson.py   (edit and re-run)${RS}"
echo "${DM}  python /tmp/lesson.py${RS}"
echo "${DM}  Try adding a class or reading a file${RS}"`,
      },
      {
        name: 'TypeScript',
        desc: 'Types catch bugs early',
        icon: '\u{1F4D8}',
        level: 'beginner',
        cmd: `echo "${CY}--- Lesson: TypeScript ---${RS}"
echo ""
echo "${DM}TypeScript adds types to JavaScript. The compiler catches mistakes before runtime.${RS}"
echo ""
echo "${GN}> Creating /tmp/myts/app.ts${RS}"
mkdir -p /tmp/myts && cat > /tmp/myts/app.ts << 'ENDTS'
// TypeScript = JavaScript + type annotations
// The compiler catches errors before your code runs

interface Person {
  name: string;
  age: number;
  hobbies: string[];
}

function greet(person: Person): string {
  return "Hi " + person.name + "! You like " + person.hobbies.join(" and ") + ".";
}

var alice: Person = {
  name: "Alice",
  age: 25,
  hobbies: ["coding", "hiking"]
};

console.log(greet(alice));

// Try uncommenting this line — TypeScript catches the error:
// var broken: Person = { name: "Bob" };  // Missing age and hobbies!

// Arrays with types
var numbers: number[] = [1, 2, 3, 4, 5];
var doubled = numbers.map(function(n) { return n * 2; });
console.log("Doubled: " + JSON.stringify(doubled));

// Generics — functions that work with any type
function first<T>(arr: T[]): T | undefined {
  return arr[0];
}
console.log("First number: " + first(numbers));
console.log("First hobby: " + first(alice.hobbies));

// Union types — a value can be one of several types
function format(value: string | number): string {
  if (typeof value === "string") {
    return value.toUpperCase();
  }
  return value.toFixed(2);
}
console.log(format("hello"));
console.log(format(3.14159));
ENDTS
echo ""
echo "${GN}> Building TypeScript to JavaScript...${RS}"
build /tmp/myts/app.ts --outfile=/tmp/myts/app.js
echo ""
echo "${GN}> Running...${RS}"
node /tmp/myts/app.js
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  vi /tmp/myts/app.ts   (edit and rebuild)${RS}"
echo "${DM}  cat /tmp/myts/app.js  (see compiled output)${RS}"
echo "${DM}  build /tmp/myts/app.ts --outfile=/tmp/myts/app.js && node /tmp/myts/app.js${RS}"`,
      },
      {
        name: 'C Program',
        desc: 'Compile and run C code',
        icon: '\u2699\uFE0F',
        level: 'intermediate',
        cmd: `echo "${CY}--- Lesson: C Programming ---${RS}"
echo ""
echo "${DM}C is a low-level language. You compile source code to a binary, then run it.${RS}"
echo ""
echo "${GN}> Creating /tmp/hello.c${RS}"
cat > /tmp/hello.c << 'ENDC'
#include <stdio.h>
#include <string.h>

/* A struct groups related data together */
typedef struct {
    char name[50];
    int age;
    float gpa;
} Student;

void print_student(Student s) {
    printf("  %s (age %d, GPA %.1f)\\n", s.name, s.age, s.gpa);
}

int main() {
    printf("Hello from C!\\n\\n");

    /* Create an array of structs */
    Student class_list[3];
    strcpy(class_list[0].name, "Alice");
    class_list[0].age = 14;
    class_list[0].gpa = 3.8;

    strcpy(class_list[1].name, "Bob");
    class_list[1].age = 15;
    class_list[1].gpa = 3.2;

    strcpy(class_list[2].name, "Carol");
    class_list[2].age = 14;
    class_list[2].gpa = 3.9;

    printf("Students:\\n");
    for (int i = 0; i < 3; i++) {
        print_student(class_list[i]);
    }

    /* Pointers: a variable that stores a memory address */
    int x = 42;
    int *ptr = &x;
    printf("\\nPointers:\\n");
    printf("  x = %d\\n", x);
    *ptr = 99;
    printf("  After *ptr = 99: x = %d\\n", x);

    return 0;
}
ENDC
echo ""
echo "${GN}> Compiling...${RS}"
cc /tmp/hello.c -o /tmp/hello
echo ""
echo "${GN}> Running...${RS}"
/tmp/hello
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  vi /tmp/hello.c   (edit the code)${RS}"
echo "${DM}  cc /tmp/hello.c -o /tmp/hello && /tmp/hello${RS}"
echo "${DM}  Try adding a function or a loop${RS}"`,
      },
    ],
  },
  {
    name: 'Packages',
    templates: [
      {
        name: 'WASM Packages',
        desc: 'Real WASM packages from Wasmer',
        icon: '\u{1F4E6}',
        level: 'intermediate',
        cmd: `echo "${CY}--- WASM Packages: Real Software in the Browser ---${RS}"
echo ""
echo "${DM}Shiro can install real packages from the ${BD}Wasmer registry${RS}${DM}.${RS}"
echo "${DM}These are WebAssembly binaries — compiled code running at near-native speed.${RS}"
echo "${DM}22 packages available, cached in IndexedDB for instant re-runs.${RS}"
echo ""
echo "${GN}> Installing cowsay...${RS}"
pkg install cowsay && echo "${GN}> Installing figlet...${RS}" && pkg install figlet && echo "${GN}> Installing fortune...${RS}" && pkg install fortune
echo ""
echo "${YL}--- figlet: ASCII art text ---${RS}"
echo "SHIRO" | figlet
echo ""
echo "${YL}--- cowsay: talking cow ---${RS}"
echo "Real packages in a browser!" | cowsay
echo ""
echo "${YL}--- fortune | cowsay: chained pipeline ---${RS}"
fortune | cowsay
echo ""
echo "${DM}These are real WASM binaries from cdn.wasmer.io, not JavaScript shims.${RS}"
echo "${DM}They run in a WASI sandbox with full stdin/stdout piping.${RS}"
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  pkg available                    (see all 22 packages)${RS}"
echo "${DM}  pkg install qr2text && echo 'https://shiro.computer' | qr2text${RS}"
echo "${DM}  pkg install lolcat && echo 'Rainbow text!' | lolcat${RS}"
echo "${DM}  fortune | figlet | lolcat        (triple pipeline)${RS}"`,
      },
      {
        name: 'x86 Linux Binaries',
        desc: 'Real Linux ELF binaries in-browser',
        icon: '\u{1F9EC}',
        level: 'advanced',
        cmd: `echo "${CY}--- x86-64 Emulator: Real Linux Binaries ---${RS}"
echo ""
echo "${DM}Shiro includes a full ${BD}x86-64 emulator${RS}${DM} that runs real Linux ELF binaries.${RS}"
echo "${DM}Not transpiled. Not interpreted. Actual x86 instructions decoded and executed.${RS}"
echo ""
echo "${GN}> Installing busybox (1.1 MB real ELF binary)...${RS}"
xpkg install busybox
echo ""
echo "${YL}--- uname: real binary, real output ---${RS}"
busybox uname -a
echo ""
echo "${YL}--- ash: a real POSIX shell running inside x86 emulation ---${RS}"
busybox ash -c 'for i in 1 2 3; do echo "Hello from x86 #$i"; done'
echo ""
echo "${YL}--- piping stdin to x86 binary ---${RS}"
seq 1 10 | busybox awk '{s+=$1} END {print "Sum of 1..10:", s}'
echo ""
echo "${YL}--- md5sum: cryptographic hash via x86 ---${RS}"
echo "Shiro x86" | busybox md5sum
echo ""
echo "${YL}--- fibonacci with awk ---${RS}"
busybox awk 'BEGIN {a=0;b=1; for(i=0;i<12;i++){printf "%d ",a; c=a+b;a=b;b=c} print ""}'
echo ""
echo "${DM}This is a ${BD}real 1.1 MB statically-linked ELF binary${RS}${DM} running in the browser.${RS}"
echo "${DM}~130 x86 instructions decoded, ~58 Linux syscalls emulated.${RS}"
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  xpkg available                   (see all x86 packages)${RS}"
echo "${DM}  xpkg install bc && echo '2^64' | bc${RS}"
echo "${DM}  busybox ls -la /                 (list VFS root)${RS}"
echo "${DM}  busybox ash                      (interactive x86 shell!)${RS}"`,
      },
    ],
  },
  {
    name: 'Tools',
    templates: [
      {
        name: 'SQLite Database',
        desc: 'Tables, queries, and joins',
        icon: '\u{1F5C4}\uFE0F',
        level: 'beginner',
        cmd: `echo "${CY}--- Lesson: SQL with SQLite ---${RS}"
echo ""
echo "${DM}SQL is the language of databases. Create tables, insert data, query it.${RS}"
echo ""
echo "${GN}> Creating database and table...${RS}"
cat > /tmp/setup.sql << 'ENDSQL'
CREATE TABLE IF NOT EXISTS students (name TEXT, age INTEGER, grade TEXT);
INSERT INTO students VALUES ('Alice', 14, 'A');
INSERT INTO students VALUES ('Bob', 15, 'B');
INSERT INTO students VALUES ('Carol', 14, 'A');
INSERT INTO students VALUES ('Dave', 16, 'C');
INSERT INTO students VALUES ('Eve', 15, 'A');
SELECT 'All students:';
SELECT name, age, grade FROM students;
SELECT '';
SELECT 'Grade A students:';
SELECT name, age FROM students WHERE grade = 'A';
SELECT '';
SELECT 'Count by grade:';
SELECT grade, COUNT(*) as count FROM students GROUP BY grade ORDER BY grade;
ENDSQL
sqlite3 /tmp/lesson.db < /tmp/setup.sql
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  sqlite3 /tmp/lesson.db   (interactive mode)${RS}"
echo "${DM}  Try: SELECT * FROM students WHERE age > 14;${RS}"
echo "${DM}  Try: UPDATE students SET grade='A' WHERE name='Bob';${RS}"`,
      },
      {
        name: 'Shell Tutorial',
        desc: 'Files, pipes, and redirects',
        icon: '\u{1F41A}',
        level: 'beginner',
        cmd: `echo "${CY}--- Lesson: The Shell ---${RS}"
echo ""
echo "${DM}The shell is your command line. Learn to navigate files, search, and chain commands.${RS}"
echo ""
echo "${GN}> Creating sample files...${RS}"
mkdir -p /tmp/tutorial
echo "Alice,25,Engineer" > /tmp/tutorial/people.csv
echo "Bob,30,Designer" >> /tmp/tutorial/people.csv
echo "Carol,28,Developer" >> /tmp/tutorial/people.csv
echo "Dave,35,Manager" >> /tmp/tutorial/people.csv
echo "Eve,22,Developer" >> /tmp/tutorial/people.csv
echo ""
echo "${CY}--- cat: read files ---${RS}"
cat /tmp/tutorial/people.csv
echo ""
echo "${CY}--- grep: search for patterns ---${RS}"
echo "${DM}(finding lines with 'Developer')${RS}"
grep Developer /tmp/tutorial/people.csv
echo ""
echo "${CY}--- sort: alphabetical order ---${RS}"
cat /tmp/tutorial/people.csv | sort
echo ""
echo "${CY}--- pipes: chain commands ---${RS}"
echo "${DM}(sort, then take first 3 lines)${RS}"
cat /tmp/tutorial/people.csv | sort | head -3
echo ""
echo "${CY}--- redirects: save output to a file ---${RS}"
echo "${DM}(saving sorted data to sorted.csv)${RS}"
cat /tmp/tutorial/people.csv | sort > /tmp/tutorial/sorted.csv
cat /tmp/tutorial/sorted.csv
echo ""
echo "${CY}--- wc: count lines ---${RS}"
cat /tmp/tutorial/people.csv | wc -l
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  grep -v Alice /tmp/tutorial/people.csv   (exclude Alice)${RS}"
echo "${DM}  echo 'Frank,27,Artist' >> /tmp/tutorial/people.csv${RS}"
echo "${DM}  ls /tmp/tutorial${RS}"
echo "${DM}  cat /tmp/tutorial/people.csv | cut -d, -f1${RS}"`,
      },
      {
        name: 'Cross-Language Pipeline',
        desc: 'Five languages, one pipeline',
        icon: '\u{1F500}',
        level: 'advanced',
        cmd: `echo "${CY}--- Cross-Language Pipeline ---${RS}"
echo ""
echo "${DM}Five languages processing data through Shiro's shared virtual filesystem.${RS}"
echo "${DM}Each step reads the previous step's output — no IPC, just files.${RS}"
echo ""
echo "${YL}=== Step 1/5: C — Generate sensor data ===${RS}"
echo "${GN}> Creating /tmp/pipeline/generate.c${RS}"
mkdir -p /tmp/pipeline && cat > /tmp/pipeline/generate.c << 'ENDC'
#include <stdio.h>
#include <math.h>

int main() {
    FILE *f = fopen("/tmp/pipeline/data.csv", "w");
    fprintf(f, "sensor,hour,value\\n");
    for (int h = 0; h < 24; h++) {
        double temp = 20.0 + 8.0 * sin((h - 6) * 3.14159 / 12.0) + (h % 3) * 0.7;
        double humid = 60.0 + 15.0 * cos((h - 14) * 3.14159 / 12.0) - (h % 5) * 0.5;
        fprintf(f, "temp,%d,%.1f\\n", h, temp);
        fprintf(f, "humidity,%d,%.1f\\n", h, humid);
    }
    fclose(f);
    printf("Generated 48 sensor readings to data.csv\\n");
    return 0;
}
ENDC
cc /tmp/pipeline/generate.c -o /tmp/pipeline/generate && /tmp/pipeline/generate
echo ""
echo "${YL}=== Step 2/5: Node.js — Transform CSV to JSON ===${RS}"
echo "${GN}> Creating /tmp/pipeline/transform.js${RS}"
cat > /tmp/pipeline/transform.js << 'ENDJS'
var fs = require('fs');
var csv = fs.readFileSync('/tmp/pipeline/data.csv', 'utf8');
var lines = csv.trim().split('\\n').slice(1);
var records = lines.map(function(line) {
  var parts = line.split(',');
  return { sensor: parts[0], hour: parseInt(parts[1]), value: parseFloat(parts[2]) };
});

var sensors = {};
for (var i = 0; i < records.length; i++) {
  var r = records[i];
  if (!sensors[r.sensor]) sensors[r.sensor] = { values: [], min: Infinity, max: -Infinity, sum: 0 };
  var s = sensors[r.sensor];
  s.values.push(r.value);
  s.sum += r.value;
  if (r.value < s.min) s.min = r.value;
  if (r.value > s.max) s.max = r.value;
}

var stats = {};
for (var name in sensors) {
  var s = sensors[name];
  stats[name] = { min: s.min, max: s.max, avg: Math.round(s.sum / s.values.length * 10) / 10, count: s.values.length };
}

var result = { records: records, stats: stats };
fs.writeFileSync('/tmp/pipeline/data.json', JSON.stringify(result, null, 2));
console.log('Stats:', JSON.stringify(stats));
ENDJS
node /tmp/pipeline/transform.js
echo ""
echo "${YL}=== Step 3/5: Python — Anomaly detection ===${RS}"
echo "${DM}(Loading Pyodide runtime... ~12 MB first time)${RS}"
echo "${GN}> Creating /tmp/pipeline/analyze.py${RS}"
cat > /tmp/pipeline/analyze.py << 'ENDPY'
import json

with open('/shiro/tmp/pipeline/data.json') as f:
    data = json.load(f)

records = data['records']
by_sensor = {}
for r in records:
    by_sensor.setdefault(r['sensor'], []).append(r['value'])

print("Anomaly Report:")
print("-" * 40)
for sensor, values in by_sensor.items():
    mean = sum(values) / len(values)
    anomalies = []
    for i, v in enumerate(values):
        deviation = abs(v - mean) / mean * 100
        if deviation > 35:
            anomalies.append((i, v, deviation))
    if anomalies:
        print(f"  {sensor}: {len(anomalies)} anomalies (mean={mean:.1f})")
        for idx, val, dev in anomalies:
            print(f"    hour {idx}: {val:.1f} ({dev:.0f}% from mean)")
    else:
        print(f"  {sensor}: no anomalies (mean={mean:.1f})")
ENDPY
(cd /tmp/pipeline && python analyze.py)
echo ""
echo "${YL}=== Step 4/5: SQLite — Query peak values ===${RS}"
cat > /tmp/pipeline/query.sql << 'ENDSQL'
.mode column
.headers on
CREATE TABLE readings (sensor TEXT, hour INTEGER, value REAL);
.import /tmp/pipeline/data.csv readings
DELETE FROM readings WHERE sensor = 'sensor';

SELECT '--- Peak temperature hours ---';
SELECT hour, value FROM readings WHERE sensor='temp' ORDER BY value DESC LIMIT 5;
SELECT '';
SELECT '--- Peak humidity hours ---';
SELECT hour, value FROM readings WHERE sensor='humidity' ORDER BY value DESC LIMIT 5;
ENDSQL
sqlite3 < /tmp/pipeline/query.sql
echo ""
echo "${YL}=== Step 5/5: Shell — ASCII temperature chart ===${RS}"
echo "Hour | Temperature"
echo "-----|------------"
sqlite3 /tmp/pipeline/pipeline.db << 'ENDSQL' | while IFS='|' read hour val; do bar=""; i=0; limit=$(echo "$val" | cut -d. -f1); while [ $i -lt $limit ] && [ $i -lt 30 ]; do bar="$bar#"; i=$((i+1)); done; printf "%4s | %-30s %s\\n" "$hour" "$bar" "$val"; done
CREATE TABLE IF NOT EXISTS r (sensor TEXT, hour INTEGER, value REAL);
DELETE FROM r;
.import /tmp/pipeline/data.csv r
DELETE FROM r WHERE sensor = 'sensor';
SELECT hour, value FROM r WHERE sensor='temp' ORDER BY hour;
ENDSQL
echo ""
echo "${CY}--- Pipeline complete! ---${RS}"
echo "${DM}5 languages, 1 shared filesystem, 0 network calls.${RS}"
echo ""
echo "${DM}What to try next:${RS}"
echo "${DM}  cat /tmp/pipeline/data.csv | head   (raw CSV)${RS}"
echo "${DM}  cat /tmp/pipeline/data.json | head   (JSON with stats)${RS}"
echo "${DM}  sqlite3 (interactive SQL on the data)${RS}"`,
      },
    ],
  },
];

/**
 * Genre labels and colors for living templates.
 */
const genreInfo: Record<string, { label: string; color: string }> = {
  quest: { label: 'QUESTS', color: '#ef4444' },
  mirror: { label: 'CREATE', color: '#3b82f6' },
  automator: { label: 'AUTOMATE', color: '#f59e0b' },
  canvas: { label: 'ART', color: '#c084fc' },
  collaborator: { label: 'AI', color: '#8b5cf6' },
};

/**
 * Build a template row element (shared between living and classic templates).
 */
function makeRow(
  icon: string,
  name: string,
  desc: string,
  level: string,
  time: string | undefined,
  onClick: () => void,
): HTMLDivElement {
  const levelColors: Record<string, string> = {
    beginner: '#22c55e',
    intermediate: '#eab308',
    advanced: '#ef4444',
  };

  const row = document.createElement('div');
  row.style.cssText = `
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: 8px; cursor: pointer;
    transition: background 0.1s;
  `;
  row.onmouseenter = () => { row.style.background = 'rgba(255,255,255,0.06)'; };
  row.onmouseleave = () => { row.style.background = 'none'; };

  const iconEl = document.createElement('span');
  iconEl.textContent = icon;
  iconEl.style.cssText = 'font-size: 20px; width: 28px; text-align: center; flex-shrink: 0;';

  const text = document.createElement('div');
  text.style.cssText = 'flex: 1; min-width: 0;';
  const nameEl = document.createElement('div');
  nameEl.textContent = name;
  nameEl.style.cssText = 'color: rgba(255,255,255,0.9); font-size: 13px; font-weight: 500;';
  const descEl = document.createElement('div');
  descEl.textContent = desc + (time ? `  ${time}` : '');
  descEl.style.cssText = 'color: rgba(255,255,255,0.35); font-size: 11px; margin-top: 1px;';
  text.appendChild(nameEl);
  text.appendChild(descEl);

  const badge = document.createElement('span');
  badge.textContent = level;
  badge.style.cssText = `
    font-size: 10px; color: ${levelColors[level] || '#888'};
    opacity: 0.7; flex-shrink: 0; text-transform: uppercase;
    letter-spacing: 0.5px;
  `;

  // Check for progress
  const progressKey = 'shiro-template-progress-';
  // We'll check for any completed checkpoints later

  row.appendChild(iconEl);
  row.appendChild(text);
  row.appendChild(badge);
  row.onclick = onClick;
  return row;
}

/**
 * Show the template palette modal with living templates and classic templates.
 */
export function showTemplatePalette(
  runCmd: (name: string, cmd: string, splitPort?: number) => void,
  runLiving?: (templateId: string) => void,
): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(0,0,0,0.5); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: #1a1a2e; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px; padding: 20px; width: 420px; max-width: 90vw;
    max-height: 80vh; overflow-y: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  `;

  const title = document.createElement('div');
  title.textContent = 'Learn';
  title.style.cssText = 'color: #fff; font-size: 16px; font-weight: 600; margin-bottom: 12px;';
  modal.appendChild(title);

  // ── Living Templates (interactive guided tutorials) ──
  if (runLiving) {
    // Dynamic import to keep bundle lean
    import('./living-templates').then(({ livingTemplates }) => {
      // Group by genre
      const byGenre = new Map<string, typeof livingTemplates>();
      for (const t of livingTemplates) {
        if (!byGenre.has(t.genre)) byGenre.set(t.genre, []);
        byGenre.get(t.genre)!.push(t);
      }

      // Insert living templates before the classic ones (before first child after title)
      const insertBefore = modal.children[1] as HTMLElement | null; // first classic header

      for (const [genre, templates] of byGenre) {
        const info = genreInfo[genre] || { label: genre.toUpperCase(), color: '#888' };
        const header = document.createElement('div');
        header.style.cssText = `
          color: ${info.color}; font-size: 11px; font-weight: 600;
          letter-spacing: 1px; padding: 12px 12px 4px; margin-top: 4px;
        `;
        header.innerHTML = `${info.label} <span style="color:rgba(255,255,255,0.2);font-size:10px;font-weight:400;margin-left:4px">guided</span>`;
        if (insertBefore) modal.insertBefore(header, insertBefore);
        else modal.appendChild(header);

        for (const t of templates) {
          const row = makeRow(t.icon, t.name, t.desc, t.level, t.time, () => {
            overlay.remove();
            runLiving(t.id);
          });
          if (insertBefore) modal.insertBefore(row, insertBefore);
          else modal.appendChild(row);
        }
      }

      // Divider between living and classic
      const divider = document.createElement('div');
      divider.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.06); margin: 12px 0 4px;';
      if (insertBefore) modal.insertBefore(divider, insertBefore);
      else modal.appendChild(divider);
    }).catch(() => {});
  }

  // ── Classic Templates (shell command strings) ──
  for (const cat of categories) {
    const header = document.createElement('div');
    header.textContent = cat.name.toUpperCase();
    header.style.cssText = `
      color: rgba(255,255,255,0.3); font-size: 11px; font-weight: 600;
      letter-spacing: 1px; padding: 12px 12px 4px; margin-top: 4px;
    `;
    modal.appendChild(header);

    for (const tmpl of cat.templates) {
      const row = makeRow(tmpl.icon, tmpl.name, tmpl.desc, tmpl.level, undefined, () => {
        overlay.remove();
        runCmd(tmpl.name, tmpl.cmd, tmpl.splitPort);
      });
      modal.appendChild(row);
    }
  }

  overlay.appendChild(modal);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  document.body.appendChild(overlay);
}
