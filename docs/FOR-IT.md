# For IT: firewall rule for the Engineering Board

The Engineering Board is an internal web app for the mechanical design team. It runs as an ordinary user process on one workstation (the *host*) and is used from colleagues' browsers on the office LAN. **One inbound firewall rule on the host** is all it needs from IT.

| | |
|---|---|
| **Program** | `node.exe` (official Node.js 22 LTS build, a single file, no installer) running `app\server.mjs` from the user's board folder |
| **Runs as** | the signed-in user; no service, no admin rights, no registry changes |
| **Listens on** | TCP **8080** (configurable), all interfaces |
| **Outbound traffic** | none; it needs no internet access |
| **Data** | one SQLite file in the board folder (`data\board.db`), drawing-review PDFs in `data\review-files`, plus daily backup copies |
| **Writes to shares** | only for drawing review: into a job's project folder, under `BoardReview\` and a generated `REVISION_LOG.md`, as the signed-in user. It never changes or deletes files it didn't write. |
| **Starts** | by the user, or at sign-in from the user's own Startup folder |

## The rule

Either run **`for-IT\allow-board-port.bat`** from the board folder **as administrator** (it reads the port from `config.json`, adds the rule, and lists any conflicting Block rules), or add it yourself:

```bat
netsh advfirewall firewall add rule name="Engineering Board" dir=in action=allow protocol=TCP localport=8080 profile=domain,private
```

PowerShell equivalent:

```powershell
New-NetFirewallRule -DisplayName "Engineering Board" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -Profile Domain,Private
```

To limit it to the office subnet, add `remoteip=192.168.1.0/24` (netsh) or `-RemoteAddress 192.168.1.0/24` (PowerShell), with your subnet.

## Check for Block rules on node.exe

The first time the board starts, Windows shows "Allow node.exe to communicate on these networks". A user without admin rights can only click Cancel, and Windows may then create an **inbound Block rule for node.exe**. Block rules take precedence over Allow rules, so remove it:

```powershell
Get-NetFirewallApplicationFilter | Where-Object Program -like '*\node.exe' |
  Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |
  Remove-NetFirewallRule
```

Or in **Windows Defender Firewall with Advanced Security → Inbound Rules**, delete the "node.exe" or "Node.js JavaScript Runtime" rules with a red Block icon.

## Opening folders from the board

A job's **File location** has a **Go to location** button that links to the folder as a `file://` address (for example `file://FILESERVER/Projects/P-1042`). Browsers refuse to open such links from a web page unless told to, so without the setting below the button does nothing and people use **Copy** instead.

**Microsoft Edge** has a policy for exactly this case, intranet file links: `IntranetFileLinksEnabled`. With it on, Edge opens the folder in File Explorer when the link is clicked (the board's address must count as an intranet site, which a plain PC name or private IP does). Set it by Group Policy (*Microsoft Edge → Allow Internet Explorer mode… → "Allow file URL links to open in Windows Explorer from intranet sites"*; the policy name in the ADMX is **IntranetFileLinksEnabled**) or with the registry value:

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Edge]
"IntranetFileLinksEnabled"=dword:00000001
```

Google Chrome has no equivalent policy; Firefox needs `capability.policy` settings in a policy file. Nothing is needed on the host PC: the link is followed by each person's own browser and opens the folder with their own permissions.

## Nice to have

- A **reserved IP address** (DHCP reservation) or a **DNS name** for the host PC, so the address colleagues bookmark never changes.
- Make sure the host's connection uses the **Domain** or **Private** network profile, not Public.
- Allowlisting `node.exe` in the board folder if AppLocker or antivirus policies block unknown executables.

## To remove it

```bat
netsh advfirewall firewall delete rule name="Engineering Board"
```
