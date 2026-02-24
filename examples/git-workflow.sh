# Git Workflow — version control in the browser
# Uses isomorphic-git. All operations are client-side.

# Create a project
mkdir -p /home/user/repo && cd /home/user/repo

# Initialize a git repository
git init

# Create some files
echo '# My Project' > /home/user/repo/README.md
cat > /home/user/repo/app.js << 'EOF'
function greet(name) {
  return "Hello, " + name;
}
console.log(greet("World"));
EOF

# Stage and commit
git add .
git commit -m "Initial commit: add README and app"

# Check the log
git log --oneline

# Make changes
cat > /home/user/repo/app.js << 'EOF'
function greet(name) {
  return "Hello, " + name + "!";
}

function farewell(name) {
  return "Goodbye, " + name;
}

console.log(greet("World"));
console.log(farewell("World"));
EOF

# See what changed
git diff

# Stage and commit the changes
git add .
git commit -m "Add farewell function, fix greeting punctuation"

# View full log
git log

# Check status (should be clean)
git status

# Clean up
cd /home/user
rm -r /home/user/repo
