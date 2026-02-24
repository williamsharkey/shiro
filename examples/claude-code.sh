# Claude Code — AI coding in the browser
# The real @anthropic-ai/claude-code CLI runs inside Shiro.
# Requires OAuth setup first: run `setup` to sign in.

# Print mode — one-shot code generation
claude -p "Write a JavaScript function that checks if a string is a palindrome"

# Generate files
claude -p "Create a simple TODO app with add/remove/list functions in todo.js"
cat /home/user/todo.js

# Pipe input for analysis
cat /home/user/todo.js | claude -p "Review this code and suggest improvements"

# Interactive mode — full conversation (opens in a new window)
# sc

# Claude Code can read, edit, and create files in the virtual filesystem.
# It uses the same tools as the desktop version: Read, Write, Edit, Grep, Glob, Bash.
