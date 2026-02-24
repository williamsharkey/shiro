# npm Project — package management and Node.js
# Demonstrates npm init, install, require(), and scripts

# Create a project directory
mkdir -p /home/user/myapp && cd /home/user/myapp

# Initialize a package.json
npm init -y

# Install a package
npm install lodash

# List installed packages
npm list

# Use the package in a script
cat > /home/user/myapp/index.js << 'SCRIPT'
const _ = require('lodash');
const nums = [1, 1, 2, 3, 3, 4];
console.log('Unique:', _.uniq(nums));
console.log('Sum:', _.sum(nums));
console.log('Chunk:', _.chunk(nums, 2));
SCRIPT

# Run it
node /home/user/myapp/index.js

# Add a script to package.json and run it
node -e "
const pkg = JSON.parse(require('fs').readFileSync('/home/user/myapp/package.json','utf8'));
pkg.scripts = { start: 'node index.js' };
require('fs').writeFileSync('/home/user/myapp/package.json', JSON.stringify(pkg, null, 2));
"
npm run start

# Clean up
cd /home/user
rm -r /home/user/myapp
