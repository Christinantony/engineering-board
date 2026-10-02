# Troubleshooting

Most problems show up in the **board's window** on the host PC, in plain words. Look there first.

## The board won't start

| The window says | Do this |
|---|---|
| `node.exe is missing from this folder` | Put `node.exe` next to `start.bat`. See [Install](INSTALL.md#1-install-on-windows). |
| `This node.exe is version 20.x … needs Node.js 22.16 or newer` | Replace `node.exe` with the current 22 LTS one from nodejs.org. |
| `has its built-in SQLite turned off` | Something sets `--no-experimental-sqlite` (usually the `NODE_OPTIONS` environment variable). Remove it. |
| `Port 8080 is already in use. Is the board already running?` | It usually is: look for another board window, including a minimised one in the taskbar. If another program needs 8080, set a different `port` in `config.json` (and ask IT to open that one instead). |
| `config.json could not be read` / `Some settings are not right` | The message names the setting and what's wrong. Fix it in Notepad, or delete `config.json` to go back to the defaults. |
| `This data was written by a newer version of the board` | You put an older `app` folder back after an update. Use the newer version, or restore a backup made by this version (see [Updating](INSTALL.md#5-update-to-a-new-version)). |
| `database is locked` or `unable to open database file` | Another board, or a sync tool, has the database open. Don't keep `data` inside OneDrive or a network share: point only `backupDir` there. |
| The window flashes and closes | Open a Command Prompt in the board folder and type `start.bat` to see the message. |

## Colleagues can't open the board

Work through these in order. "Host" is the PC running the board.

1. **On the host,** does <http://localhost:8080> work? If not, the board isn't running: see above.
2. **Is `host` set to `127.0.0.1`** in `config.json`? That allows the host PC only. Set it to `0.0.0.0`, or remove the line.
3. **Is the address right?** Use the "For your team" address the board's window shows. If the PC-name address fails but the number works, the network doesn't publish PC names: use the number for now and ask IT for a reserved IP address or a DNS name.
4. **Firewall.** If the page times out from other PCs, the firewall is blocking the port. IT needs to add the rule in [For IT](FOR-IT.md), and **remove any "Block" rule for node.exe**. Windows creates those when someone without admin rights clicks Cancel on the "allow access" prompt, and a Block rule wins over an Allow rule.
5. **Network type.** The rule covers Domain and Private networks. If the host's connection is set to *Public* (**Settings → Network & internet → Ethernet → Network profile type**), the rule doesn't apply.
6. **Same network?** People working from home over VPN may be on a separate network segment that can't reach office PCs. That's a question for IT.

## While using it

| What you see | What it means |
|---|---|
| Red banner "Can't reach the board server" | The host PC is off, asleep, restarting or lost its network. Changes made now aren't saved. It reconnects by itself and catches up. If it happens often, stop the host PC sleeping (see [Keep it running](INSTALL.md#4-keep-it-running)). |
| "The board has been updated on the server" | A new version is running. Click **Reload**. |
| "Someone else changed this" | Another person saved first; their version is shown. Redo your change if it's still needed. |
| A job seems to have vanished | Done jobs leave the board after 7 days, and archived jobs leave every list. Use Search with "Include archived jobs". Nothing is ever deleted. |
| Pages are blank or look broken after an update | Press <kbd>Ctrl</kbd>+<kbd>F5</kbd> to reload without the browser's cache. |
| The wrong name is shown | **Your name → Sign out**, then sign in as yourself. |
| "That password isn't right" | Passwords are case-sensitive. Forgotten it? Whoever looks after the board resets it under **Admin → Team**; you then create a new one when you sign in. |
| "Too many wrong passwords" | After five wrong tries sign-in for that name pauses for 30 seconds. Wait, then try again. |
| "has no password yet" or the board asks you to create a password | You haven't signed in since passwords were added, or an admin reset yours. Create a new password; the board signs you in with it. |
| Asked to sign in again out of the blue | Your password was changed in another browser, an admin reset it, or the board was updated to 1.2.0 (everyone signs in with a password from then on). |
| Admin keeps asking for the PIN | It stays unlocked for 12 hours per browser. Private/incognito windows forget it when closed. |
| "… has 2 pages. Each drawing … must be a single-page PDF" | Drawing review takes one sheet per PDF. Export each sheet of the drawing to its own PDF, named with its part number. |
| "This PDF is encrypted or password-protected" | Save or export it again without security settings (in the scanner software or the PDF printer), then attach it again. |
| "Project folder copies need attention" on a review | The project share was offline, read-only, or already had a file of that name the board didn't write. The board keeps its own copies and retries every few minutes; **Try again** retries now. Rename or move a conflicting file the board names, if it isn't needed there. |
| A drawing shows "removed after board review" | That was an earlier attempt of a drawing that has since passed; its PDF was tidied away on purpose. Its notes, comments and decision are kept. |
| The review PDF viewer stays blank | Reload with <kbd>Ctrl</kbd>+<kbd>F5</kbd>. A very old browser may not run the PDF viewer: use a current Edge or Chrome. |

## Forgotten admin PIN

On the host PC, in the board folder (next to `start.bat`), create an empty file called **`RESET-ADMIN-PIN`** (a `RESET-ADMIN-PIN.txt` made with Notepad works too). Restart the board. The PIN is back to `1234`, the window says so, and the file is removed. Change the PIN straight away. Nothing else changes.

## Forgotten passwords

**One person:** anyone signed in who knows the admin PIN opens **Admin → Team** and presses **Reset** next to their name. They create a new password at their next sign-in.

**Everyone, or the only people who know the PIN:** on the host PC, in the board folder (next to `start.bat`), create an empty file called **`RESET-PASSWORDS`** (`RESET-PASSWORDS.txt` works too). Restart the board. Every password is cleared, the window says so, and the file is removed. Everyone is signed out and creates a new password the next time they sign in, so tell the team first. Jobs, history and the admin PIN are untouched.

## Data worries

- **Did we lose anything?** Every change is saved the moment it is made. Closing the board's window, or Windows restarting, loses nothing. Only a power cut can lose the last second or so of changes.
- **Undo something big** (a wrong import, a mass archive): **Admin → Backups and restore**, then restore the backup from just before it. "Before an import" backups exist for exactly this.
- **The host PC died:** set the board up on another PC ([Install](INSTALL.md)), then restore the newest backup you have from its network or OneDrive copy via **Admin → Backups and restore → Restore from a file…**. This is why `backupDir` should point off the PC.
- **Check the database by hand:** any SQLite tool (for example *DB Browser for SQLite*) opens `board.db` or a backup read-only. Close the board before changing anything that way.

## Still stuck

Note the exact message in the board's window and what you were doing, and check **Admin → About this board** for the version. `http://<host>:8080/api/health` tells you whether the server is answering at all.
