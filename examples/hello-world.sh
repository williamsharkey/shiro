# Hello World — basic shell usage
# Demonstrates echo, pipes, variables, and command chaining

# Simple output
echo "Hello from Shiro"

# Pipes — chain commands together
echo "hello world" | sed 's/hello/goodbye/'
echo "one two three" | wc -w

# Variables
NAME="Shiro"
echo "Welcome to $NAME"

# Command chaining with &&
echo "step 1" && echo "step 2" && echo "done"

# Redirect output to a file, then read it back
echo "saved to disk" > /tmp/hello.txt
cat /tmp/hello.txt

# Command substitution
echo "Today's shell: $SHELL"
echo "Home directory: $HOME"

# Exit codes — $? holds the last command's exit code
true && echo "exit code: $?"
false || echo "previous command failed"
