# Install, run and update

The Engineering Board runs on **one PC** (the *host*). Everyone else just opens it in a web browser. There is nothing to install on their PCs.

```
HOST PC  (for example CHRISTIN-PC, 192.168.1.40)
  start.bat  →  node.exe app\server.mjs  →  data\board.db
        ▲
        │  http://CHRISTIN-PC:8080
        │
  Paul · Allen · Jeffin  (any browser on the office network)
```

It needs no internet connection, no administrator rights on the host, no database server and no npm. You will need:

| | |
|---|---|
| **The board** | `EngineeringBoard-<version>.zip` |
| **Node.js** | `node.exe`, version 22.16 or newer. It is one file, needs no installer and no admin rights. |
| **IT, once** | An inbound firewall rule for the board's port, so colleagues can connect. See [For IT](FOR-IT.md). |

## 1. Install on Windows

1. **Unzip the board** to a folder you own and that is backed up or at least not temporary, for example `C:\Users\<you>\EngineeringBoard`. Don't use *Downloads* or *Desktop* if your company clears them, and don't run it from inside the zip.
2. **Get `node.exe`.** Go to <https://nodejs.org/en/download>, choose **Windows Binary (.zip)**, **x64**, version **22 LTS**. Open the downloaded zip and copy just `node.exe` into the board folder, next to `start.bat`.
3. **Start it.** Double-click `start.bat`. A black window opens and shows:

   ```
   Engineering Board v1.0.1
   ─────────────────────────────────────────────
   On this PC:        http://localhost:8080
   For your team:     http://CHRISTIN-PC:8080
                      http://192.168.1.40:8080
   User guide:        http://localhost:8080/guides/user-guide.html
   ...
   Keep this window open. Press Ctrl+C to stop.
   ```

   **Keep that window open.** Closing it stops the board. Minimising it is fine.

   > If Windows shows a firewall prompt ("Allow node.exe to communicate on these networks"), you can't approve it without admin rights. Click **Cancel**: the board still works on this PC, and IT's rule (step 5) lets colleagues in. Tell IT you clicked Cancel, because Windows sometimes turns that into a "block" rule they need to remove.

The folder now looks like this:

```
EngineeringBoard\
  app\                 the program (replaced on every update)
  data\                board.db and backups\ (created on first start; this is everything you'd lose)
  guides\              these guides, as web pages
  for-IT\              the firewall rule for IT
  linux\               Linux and Docker files (ignore on Windows)
  node.exe             you added this
  start.bat            starts the board
  autostart-on.bat     start the board when you sign in
  autostart-off.bat
  config.example.json  settings you can change (copy to config.json first)
  README-FIRST.txt
```

## 2. First run

1. Open <http://localhost:8080> on the host PC.
2. Pick your name. The team (Christin, Paul, Allen and Jeffin as manager) is already set up. The browser remembers who you are; **Switch user** under your name changes it.
3. **Change the admin PIN.** It starts as `1234` and a banner reminds you until it is changed. Go to **your name → Admin**, unlock with `1234`, then **Admin PIN**.
4. Optional: in **Admin → Demo data**, add twelve example jobs to try things out, then remove them in one click. Removing them never touches real jobs.
5. Optional: bring in your existing job list with **Admin → Import from Excel**. See the [Admin guide](ADMIN-GUIDE.md#import-jobs-from-excel).

## 3. Let the team in

1. **Firewall.** Send IT the [For IT](FOR-IT.md) page, or ask them to run `for-IT\allow-board-port.bat` as administrator on the host PC. It adds one inbound rule for TCP 8080 on the Domain and Private networks.
2. **The address.** Give colleagues the "For your team" address shown in the board's window. Prefer the **PC-name address** (`http://CHRISTIN-PC:8080`) over the number: the number can change when the PC restarts, the name doesn't.

   To find them yourself: the PC name is in **Settings → System → About → Device name**. The IP address is the "IPv4 Address" in the output of `ipconfig` in a Command Prompt (use the adapter that's connected, usually Ethernet).

   If the name doesn't work for colleagues but the number does, the office network doesn't publish PC names. Ask IT for a fixed (reserved) IP address for the host PC, or a DNS name such as `board.yourcompany.local`.
3. **Check from another PC:** open the address. If it doesn't load, see [Troubleshooting](TROUBLESHOOTING.md#colleagues-cant-open-the-board).
4. Colleagues should bookmark it. The first time, each person picks their name.

## 4. Keep it running

- **Start at sign-in:** double-click `autostart-on.bat`. From then on the board starts by itself, minimised, whenever you sign in to Windows. `autostart-off.bat` undoes it. No admin rights needed.
- **Don't let the PC sleep:** **Settings → System → Power** → "When plugged in, put my device to sleep after" → **Never**. The screen can still turn off. If your company locks this setting, ask IT.
- **Signing out or restarting** stops the board until you sign in again. Locking the screen (Windows+L) doesn't.
- **Stopping it on purpose:** click in the board's window and press **Ctrl+C**, or just close the window. The data is safe either way: every saved change is already in the database file. Only a sudden power cut can lose the last second or so of changes, and even that doesn't damage the database.

## 5. Update to a new version

Updates never touch your data.

1. Tell the team the board will be down for a minute.
2. Close the board's window.
3. Unzip the new version somewhere temporary. Copy its **`app`** folder over the old one (replace everything in `app`). If the new version's README mentions changes to `start.bat` or other files at the top level, copy those too. **Never copy over `data`, `config.json` or `node.exe`.**
4. Start the board again.

If the new version changes the database, it first saves a backup named `…-pre-upgrade.db` (shown as "Before an upgrade" in **Admin → Backups and restore**), then upgrades. Open browsers show "The board has been updated on the server. Reload…".

**Going back to the old version:** close the board, put the old `app` folder back, then in `data\backups` find the newest `-pre-upgrade.db`, and restore it (see the [Admin guide](ADMIN-GUIDE.md#restore)). An older version refuses to start on data a newer version has changed, with a message saying so, rather than risk damaging it.

**Updating Node.js:** close the board, replace `node.exe` with a newer 22.x (or later LTS) one, start again.

## 6. Move the board to another PC

1. On the old PC: close the board.
2. Copy the whole board folder (including `data` and `node.exe`) to the new PC.
3. On the new PC: start it, ask IT for the firewall rule there, run `autostart-on.bat`, and give the team the new address.

## Linux

Needs Node.js 22.16 or newer (`node --version`). From the unzipped folder:

```sh
sh linux/start.sh          # runs in the foreground; Ctrl+C stops it
```

To run it as a service that starts at boot and restarts on failure, follow the steps at the top of `linux/engineering-board.service`. Open the port in the firewall if one is active, for example `sudo ufw allow 8080/tcp`. Settings are the same `config.json` as on Windows.

## Docker

Docker isn't needed and isn't recommended on Windows workstations (Docker Desktop needs admin rights and a licence for larger companies). On a Linux server with Docker, from the unzipped folder:

```sh
docker compose -f linux/docker-compose.yml up -d --build
```

The board is then on port 8080, with its data in the `data` folder next to `app`. Settings are environment variables in `linux/docker-compose.yml` (`EB_TIMEZONE`, `EB_BACKUP_DIR`, `EB_BACKUP_KEEP_DAYS`; see the [Admin guide](ADMIN-GUIDE.md#settings)). To update: replace `app`, then run the same command again.

## Uninstall

Run `autostart-off.bat`, close the board, and delete the folder. Keep a copy of `data` (or at least the newest file in `data\backups`) if you might want the history.
