# Barangay-Based Farmer Registration and Assistance System

Offline farmer registration and assistance web system built with **Node.js only** and **SQLite**.

## Database
The live database is `data/farmer_system.sqlite`. It is created automatically when the server starts. The starter `data/db.json` is used only to seed the SQLite database on first run.

The database stores users, farmers, assistance programs, assistance records, announcements, and audit logs. SQLite WAL mode is enabled for reliable local operation.

## Requirements
- Node.js **22.5+**
- Modern web browser

The project uses Node's built-in `node:sqlite`; **no `npm install` is required**.

## Run
```bash
node server.js
```
Then open `http://localhost:3000`.

Or:
```bash
npm start
```

## Default admin
Username: `admin`  
Password: `admin123`

Change the password before production use.

## LAN / Offline
The server listens on `0.0.0.0`. On another device connected to the same local network, open `http://YOUR-COMPUTER-IP:3000`. Normal operation does not require internet access.

## Reset database
For development/testing only:
```bash
npm run db:reset
```
Then start the server again. It will recreate the SQLite database and seed it from `data/db.json`.
