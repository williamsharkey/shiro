# SQLite Database — persistent SQL in the browser
# Uses sql.js WASM. Databases persist in IndexedDB.

# Create a database and table
sqlite3 /tmp/app.db "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT);"

# Insert data
sqlite3 /tmp/app.db "INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com');"
sqlite3 /tmp/app.db "INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com');"
sqlite3 /tmp/app.db "INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com');"

# Query
sqlite3 /tmp/app.db "SELECT * FROM users;"

# Filtered query
sqlite3 /tmp/app.db "SELECT name FROM users WHERE email LIKE '%example%';"

# Create a second table with foreign keys
sqlite3 /tmp/app.db "CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT);"
sqlite3 /tmp/app.db "INSERT INTO posts (user_id, title) VALUES (1, 'Hello World');"
sqlite3 /tmp/app.db "INSERT INTO posts (user_id, title) VALUES (1, 'Second Post');"
sqlite3 /tmp/app.db "INSERT INTO posts (user_id, title) VALUES (2, 'Bob Writes');"

# JOIN query
sqlite3 /tmp/app.db "SELECT users.name, posts.title FROM users JOIN posts ON users.id = posts.user_id;"

# Aggregate functions
sqlite3 /tmp/app.db "SELECT users.name, COUNT(posts.id) as post_count FROM users LEFT JOIN posts ON users.id = posts.user_id GROUP BY users.id;"

# List tables
sqlite3 /tmp/app.db ".tables"
