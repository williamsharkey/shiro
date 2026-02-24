# File Operations — filesystem basics
# Demonstrates mkdir, cp, mv, find, and file manipulation

# Create a directory structure
mkdir -p /home/user/project/src
mkdir -p /home/user/project/tests

# Create some files
echo 'console.log("app")' > /home/user/project/src/app.js
echo 'console.log("utils")' > /home/user/project/src/utils.js
echo 'test("works", () => {})' > /home/user/project/tests/app.test.js

# List files recursively
ls -R /home/user/project

# Copy a file
cp /home/user/project/src/app.js /home/user/project/src/app.backup.js

# Move/rename a file
mv /home/user/project/src/utils.js /home/user/project/src/helpers.js

# Find files by name
find /home/user/project -name "*.js"

# Find files by type
find /home/user/project -type f

# Check file contents
cat /home/user/project/src/app.js

# Word count across multiple files
find /home/user/project -name "*.js" | xargs wc -l

# Symbolic links
ln -s /home/user/project/src/app.js /home/user/project/app-link.js
ls -l /home/user/project/app-link.js

# Clean up
rm -r /home/user/project
