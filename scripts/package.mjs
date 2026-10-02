// Builds the deployable package: dist/EngineeringBoard-<version>.zip
//
//   npm run package
//
// Inside the zip (one top-level folder, EngineeringBoard\):
//   app\                 server.mjs + web\ (incl. web\guides\), replaced on every update
//   start.bat            start the board (needs node.exe next to it)
//   autostart-on.bat     start at Windows sign-in (Startup folder shortcut, no admin)
//   autostart-off.bat
//   config.example.json  every setting with its default; copy to config.json to change
//   README-FIRST.txt
//   guides\              the guides as web pages
//   for-IT\              firewall rule script + instructions (needs admin; for IT)
//   linux\               start.sh, systemd unit, Dockerfile, docker-compose.yml
// node.exe is NOT included: it is downloaded from nodejs.org by the person installing
// (decision #19). data\ is created on first start and never shipped.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createZip } from './lib/zip.mjs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const TOP = 'EngineeringBoard';
const stage = join('dist', 'package', TOP);
const zipPath = join('dist', `EngineeringBoard-${version}.zip`);

execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });

rmSync(join('dist', 'package'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const lf = (s) => s.replace(/\r\n/g, '\n');
const put = (to, text, eol) => {
  mkdirSync(join(stage, to, '..'), { recursive: true });
  writeFileSync(join(stage, to), eol === 'crlf' ? crlf(text) : lf(text));
};
const copyText = (from, to, eol) => put(to, readFileSync(from, 'utf8'), eol);

cpSync(join('dist', 'app'), join(stage, 'app'), { recursive: true });
cpSync(join('dist', 'app', 'web', 'guides'), join(stage, 'guides'), { recursive: true });

copyText('scripts/windows/start.bat', 'start.bat', 'crlf');
copyText('scripts/windows/autostart-on.bat', 'autostart-on.bat', 'crlf');
copyText('scripts/windows/autostart-off.bat', 'autostart-off.bat', 'crlf');
copyText('scripts/windows/for-IT/allow-board-port.bat', 'for-IT/allow-board-port.bat', 'crlf');
cpSync(join('dist', 'app', 'web', 'guides', 'for-it.html'), join(stage, 'for-IT', 'FOR-IT.html'));
copyText('config.example.json', 'config.example.json', 'crlf');
for (const f of ['start.sh', 'engineering-board.service', 'Dockerfile', 'docker-compose.yml']) copyText(`scripts/linux/${f}`, `linux/${f}`, 'lf');

put(
  'README-FIRST.txt',
  `Engineering Board ${version}
==========================

An internal workboard for the design team. It runs on this PC; everyone else
opens it in a web browser. No installer, no admin rights, no internet needed.

FIRST TIME
 1. Put node.exe in this folder, next to start.bat.
    Get it from https://nodejs.org/en/download : "Windows Binary (.zip)", x64,
    version 22 LTS. You only need node.exe from inside that zip.
 2. Double-click start.bat and keep the window open (minimising is fine).
 3. Open http://localhost:8080 in your browser, pick your name, create your
    password, and change the admin PIN (it starts as 1234) in Admin, Admin PIN.
    Everyone creates their own password the first time they sign in.
 4. For colleagues to connect, IT must allow the port once: send them
    for-IT\\FOR-IT.html, or ask them to run for-IT\\allow-board-port.bat as
    administrator. Then give everyone the "For your team" address the board's
    window shows.
 5. Optional: double-click autostart-on.bat so the board starts by itself
    whenever you sign in to Windows.

UPDATING (your data is never touched)
  Close the board's window, replace the "app" folder with the new one, and
  start it again. Keep "data", "config.json" and "node.exe".
  If an update changes the database, a backup of your data from before is
  saved first ("Before an upgrade" in Admin, Backups and restore).

WHERE THINGS ARE
  data\\               the database (board.db) and data\\backups\\ : this is everything
  guides\\             User guide, Admin guide, Install and update, Troubleshooting
  config.example.json settings you can change (copy it to config.json first)
  linux\\              for running on Linux or in Docker instead (ignore on Windows)

The guides are also on the board itself: press ? and choose "Open the user guide".
`,
  'crlf',
);

// zip it: directories first, then files, all under EngineeringBoard/
const entries = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(join('dist', 'package'), full).split('\\').join('/');
    if (statSync(full).isDirectory()) {
      entries.push({ name: `${rel}/` });
      walk(full);
    } else {
      entries.push({ name: rel, data: readFileSync(full), mode: name.endsWith('.sh') ? 0o100755 : 0o100644 });
    }
  }
};
entries.push({ name: `${TOP}/` });
walk(stage);
const zip = createZip(entries);
writeFileSync(zipPath, zip);
console.log(`\n  ${zipPath}  (${(zip.length / 1024).toFixed(0)} KB, ${entries.filter((e) => !e.name.endsWith('/')).length} files)\n`);
