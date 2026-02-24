# Web App — serve, inspect, and interact
# Demonstrates serve, page commands, split view, and become mode

# Create a simple web app
mkdir -p /tmp/myapp
cat > /tmp/myapp/index.html << 'EOF'
<!DOCTYPE html>
<html>
<body style="font-family: system-ui; padding: 20px; background: #1a1a2e; color: #e0e0e0;">
  <h1 id="title">Counter App</h1>
  <p>Count: <span id="count">0</span></p>
  <button id="inc" onclick="document.getElementById('count').textContent = ++window.c">+1</button>
  <button id="dec" onclick="document.getElementById('count').textContent = --window.c">-1</button>
  <script>window.c = 0;</script>
</body>
</html>
EOF

# Start serving
serve /tmp/myapp 3000

# Read text from the page
page :3000 text "#title"

# Click the increment button
page :3000 click "#inc"
page :3000 click "#inc"
page :3000 click "#inc"
page :3000 text "#count"

# Evaluate JavaScript in the page context
page :3000 eval "document.title"

# Open in a split view (side by side with terminal)
serve open 3000 --split right

# To go full-screen app mode:
# become 3000 myapp
# (accessible at shiro.computer/myapp)
# unbecome to return to terminal
