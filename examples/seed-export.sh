# Seed Export — snapshot and share your environment
# Export the entire filesystem as a GIF, HTML, or clipboard snippet.

# Create some state to export
mkdir -p /home/user/demo
echo "Hello from a seed!" > /home/user/demo/readme.txt
echo 'console.log("seeded")' > /home/user/demo/app.js

# Export as clipboard snippet (paste in DevTools to restore)
seed

# Export as self-contained HTML (download, open in any browser)
seed html

# Export as GIF with embedded data (drag to another Shiro to restore)
seed gif

# Self-contained blob mode (CSP-safe, no external resources)
seed blob
