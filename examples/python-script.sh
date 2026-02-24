# Python — Pyodide WASM runtime
# Full Python 3 with standard library. pip installs packages.

# One-liner
python3 -c "print('Hello from Python in the browser!')"

# Math
python3 -c "import math; print(f'Pi = {math.pi:.10f}')"

# Lists and comprehensions
python3 -c "squares = [x**2 for x in range(10)]; print(squares)"

# Write and run a script
cat > /tmp/fizzbuzz.py << 'EOF'
for i in range(1, 21):
    if i % 15 == 0:
        print("FizzBuzz")
    elif i % 3 == 0:
        print("Fizz")
    elif i % 5 == 0:
        print("Buzz")
    else:
        print(i)
EOF
python3 /tmp/fizzbuzz.py

# JSON processing
cat > /tmp/analyze.py << 'EOF'
import json

data = {"users": [
    {"name": "Alice", "score": 95},
    {"name": "Bob", "score": 87},
    {"name": "Charlie", "score": 92}
]}

avg = sum(u["score"] for u in data["users"]) / len(data["users"])
top = max(data["users"], key=lambda u: u["score"])
print(f"Average score: {avg:.1f}")
print(f"Top scorer: {top['name']} ({top['score']})")
EOF
python3 /tmp/analyze.py
