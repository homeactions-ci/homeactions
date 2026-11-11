# homeactions guard: the analyser behind hooks/guard-privileged.sh. POSIX awk (BWK awk, mawk, gawk).
#
#   HA_MODE=json     HA_JSON=<hook stdin>  -> prints "<tool_name>\n<decoded tool_input.command>" (no-jq fallback)
#   HA_MODE=analyse  HA_CMD=<command>      -> prints "ALLOW" or "DENY<TAB><reason>"
#
# It tokenises the command like a shell (quotes, escapes, comments, operators, redirections, heredocs,
# here-strings, $(...), backticks, process substitution), then inspects the word in COMMAND POSITION of every
# simple command, unwrapping env / command / exec / nohup / nice / timeout / xargs / find -exec / sh -c /
# bash -c / eval / ssh <host> <cmd>. Text that is only data (an argument to grep, echo or man; a heredoc
# written to a file by cat or tee) is never judged. Text that a shell will execute (sh -c '...', a heredoc or
# a here-string fed to sh/bash/ssh, echo '...' | bash, $(...)) is queued and analysed in turn.
#
# It is a seatbelt, not a sandbox: a script file run with `bash file.sh` is not opened. The real boundary is
# that every privileged step exists only in owner scripts (references/threat-model.md).

BEGIN {
  if (ENVIRON["HA_MODE"] == "json") { json_mode(); exit 0 }
  VERDICT = ""; QN = 0; MAXQ = 200; MAXDEPTH = 8
  UID_SELF = ENVIRON["HA_UID"]
  qpush(ENVIRON["HA_CMD"], 0)
  for (QI = 1; QI <= QN && VERDICT == ""; QI++) {
    if (Q_DEPTH[QI] > MAXDEPTH) { deny("commands nested deeper than " MAXDEPTH " levels"); break }
    PARSE_ERR = 0
    analyse(Q_STR[QI], Q_DEPTH[QI])
    if (PARSE_ERR && VERDICT == "") crude(Q_STR[QI])
  }
  if (VERDICT != "") printf "DENY\t%s\n", VERDICT
  else print "ALLOW"
  exit 0
}

function deny(r) { if (VERDICT == "") VERDICT = r }
function qpush(s, d) {
  if (s == "") return
  if (QN >= MAXQ) { deny("more than " MAXQ " nested commands"); return }
  QN++; Q_STR[QN] = s; Q_DEPTH[QN] = d
}

# Unbalanced quoting: fall back to a whole-word scan for the escalation commands (deny-biased).
function crude(s) {
  if (s ~ /(^|[^A-Za-z0-9_.-])(sudo|doas|pkexec|run0|su)([^A-Za-z0-9_-]|$)/) deny("unbalanced quoting around an escalation command")
}

# ---------------------------------------------------------------- tokeniser
function analyse(s, depth,    n, i, c, c2, j) {
  delete SW; delete SN; delete SR; delete SRN; delete SHB; delete SHS; delete SPIN; delete SPIPE
  delete PH_SEG; delete PH_DELIM; delete PH_STRIP
  NS = 1; SN[1] = 0; SRN[1] = 0; SHB[1] = ""; SHS[1] = ""; SPIN[1] = 0; SPIPE[1] = 0
  PENDN = 0; REXP = ""; WORD = ""; INW = 0; CWD_PROT = 0; DEPTH = depth
  delete VARS
  if (length(s) > 200000) { crude(s); return }
  n = length(s); i = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") {
      c2 = substr(s, i + 1, 1)
      if (c2 == "\n") { i += 2; continue }
      WORD = WORD c2; INW = 1; i += 2; continue
    }
    if (c == "'") {
      j = index(substr(s, i + 1), "'")
      if (j == 0) { PARSE_ERR = 1; WORD = WORD substr(s, i + 1); INW = 1; i = n + 1; continue }
      WORD = WORD substr(s, i + 1, j - 1); INW = 1; i += j + 1; continue
    }
    if (c == "\"") {
      i++
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "\\") {
          c2 = substr(s, i + 1, 1)
          if (c2 == "\"" || c2 == "\\" || c2 == "$" || c2 == "`") WORD = WORD c2
          else if (c2 != "\n") WORD = WORD c c2
          i += 2; continue
        }
        if (c == "\"") break
        if (c == "$" && substr(s, i + 1, 1) == "(") { j = subst_end(s, i + 2); qpush(substr(s, i + 2, j - i - 2), depth + 1); WORD = WORD "$(...)"; i = j + 1; continue }
        if (c == "`") { j = tick_end(s, i + 1); qpush(substr(s, i + 1, j - i - 1), depth + 1); i = j + 1; continue }
        WORD = WORD c; i++
      }
      if (i > n) PARSE_ERR = 1
      INW = 1; i++; continue
    }
    if (c == "$" && substr(s, i + 1, 1) == "(") { j = subst_end(s, i + 2); qpush(substr(s, i + 2, j - i - 2), depth + 1); WORD = WORD "$(...)"; INW = 1; i = j + 1; continue }
    if (c == "`") { j = tick_end(s, i + 1); qpush(substr(s, i + 1, j - i - 1), depth + 1); WORD = WORD "$(...)"; INW = 1; i = j + 1; continue }
    if ((c == "<" || c == ">") && substr(s, i + 1, 1) == "(") { j = subst_end(s, i + 2); qpush(substr(s, i + 2, j - i - 2), depth + 1); WORD = WORD "/dev/fd/63"; INW = 1; i = j + 1; continue }
    if (c == "#" && !INW) { j = index(substr(s, i), "\n"); if (j == 0) i = n + 1; else i = i + j - 1; continue }
    if (c == " " || c == "\t" || c == "\r") { endword(); i++; continue }
    if (c == "\n") { endword(); endseg(0); i = read_heredocs(s, i + 1); continue }
    if (c == "&" && substr(s, i + 1, 1) == ">") {
      endword(); i += 2; if (substr(s, i, 1) == ">") i++
      REXP = "w"; continue
    }
    if (c == ";" || c == "&" || c == "|" || c == "(" || c == ")") {
      c2 = substr(s, i + 1, 1)
      endword()
      if (c == "|" && c2 == "|") { endseg(0); i += 2; continue }
      if (c == "|") { endseg(1); i += (c2 == "&") ? 2 : 1; continue }
      if (c == "&" && c2 == "&") { endseg(0); i += 2; continue }
      if (c == ";" && c2 == ";") { endseg(0); i += 2; continue }
      endseg(0); i++; continue
    }
    if (c == ">" || c == "<") {
      if (INW && WORD ~ /^[0-9]+$/) { WORD = ""; INW = 0 } else endword()
      if (c == ">") {
        c2 = substr(s, i + 1, 1)
        if (c2 == "&") { i += 2; REXP = "dup"; continue }
        if (c2 == ">" || c2 == "|") i += 2; else i++
        REXP = "w"; continue
      }
      if (substr(s, i, 3) == "<<<") { i += 3; REXP = "hs"; continue }
      if (substr(s, i, 3) == "<<-") { i += 3; REXP = "hd-"; continue }
      if (substr(s, i, 2) == "<<") { i += 2; REXP = "hd"; continue }
      if (substr(s, i, 2) == "<>") { i += 2; REXP = "w"; continue }
      if (substr(s, i, 2) == "<&") { i += 2; REXP = "dup"; continue }
      i++; REXP = "r"; continue
    }
    WORD = WORD c; INW = 1; i++
  }
  endword(); endseg(0)
  if (PENDN > 0) PARSE_ERR = 1
  for (j = 1; j <= NS && VERDICT == ""; j++) check_seg(j)
}

function subst_end(s, i,    n, lv, c, j) {
  n = length(s); lv = 1
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { i += 2; continue }
    if (c == "'") { j = index(substr(s, i + 1), "'"); if (j == 0) { PARSE_ERR = 1; return n + 1 }; i += j + 1; continue }
    if (c == "\"") { i++; while (i <= n && substr(s, i, 1) != "\"") { if (substr(s, i, 1) == "\\") i++; i++ }; i++; continue }
    if (c == "(") lv++
    else if (c == ")") { lv--; if (lv == 0) return i }
    i++
  }
  PARSE_ERR = 1
  return n + 1
}

function tick_end(s, i,    n, c) {
  n = length(s)
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\\") { i += 2; continue }
    if (c == "`") return i
    i++
  }
  PARSE_ERR = 1
  return n + 1
}

function endword() {
  if (!INW) { return }
  if (REXP == "w") { SRN[NS]++; SR[NS, SRN[NS]] = WORD }
  else if (REXP == "hd" || REXP == "hd-") { PENDN++; PH_SEG[PENDN] = NS; PH_DELIM[PENDN] = WORD; PH_STRIP[PENDN] = (REXP == "hd-") }
  else if (REXP == "hs") { SHS[NS] = SHS[NS] "\n" WORD }
  else if (REXP == "dup") { if (WORD !~ /^[0-9]*-?$/) { SRN[NS]++; SR[NS, SRN[NS]] = WORD } }
  else if (REXP == "r") { }
  else { SN[NS]++; SW[NS, SN[NS]] = WORD }
  REXP = ""; WORD = ""; INW = 0
}

function endseg(pipe) {
  if (SN[NS] == 0 && SRN[NS] == 0 && SHS[NS] == "" && !seg_has_heredoc(NS)) { if (pipe) SPIN[NS] = 1; return }
  SPIPE[NS] = pipe
  NS++; SN[NS] = 0; SRN[NS] = 0; SHB[NS] = ""; SHS[NS] = ""; SPIN[NS] = pipe; SPIPE[NS] = 0
}

function seg_has_heredoc(k,    p) {
  for (p = 1; p <= PENDN; p++) if (PH_SEG[p] == k) return 1
  return 0
}

function read_heredocs(s, i,    p, n, j, line, cmp, body) {
  n = length(s)
  for (p = 1; p <= PENDN; p++) {
    body = ""
    while (i <= n) {
      j = index(substr(s, i), "\n")
      if (j == 0) { line = substr(s, i); i = n + 1 } else { line = substr(s, i, j - 1); i = i + j }
      cmp = line
      if (PH_STRIP[p]) sub(/^\t+/, "", cmp)
      if (cmp == PH_DELIM[p]) { PH_DELIM[p] = ""; break }
      body = body line "\n"
    }
    if (PH_DELIM[p] != "") PARSE_ERR = 1
    SHB[PH_SEG[p]] = SHB[PH_SEG[p]] body
  }
  PENDN = 0
  return i
}

# ---------------------------------------------------------------- per simple command
function check_seg(k,    j) {
  delete A; AN = SN[k]
  for (j = 1; j <= AN; j++) A[j] = SW[k, j]
  for (j = 1; j <= SRN[k]; j++) if (protected(SR[k, j])) deny("redirecting output into " SR[k, j] " (a system path)")
  STDIN_SHELL = 0
  if (AN > 0) check_cmd(1, k)
  if (STDIN_SHELL) {
    qpush(SHB[k], DEPTH + 1)
    qpush(SHS[k], DEPTH + 1)
    if (SPIN[k] && k > 1) feed_from(k - 1)
  }
}

# What a pipeline producer feeds into a shell: echo/printf arguments, and any heredoc or here-string.
function feed_from(p,    j, b, first, joined) {
  qpush(SHB[p], DEPTH + 1)
  qpush(SHS[p], DEPTH + 1)
  first = 1
  while (first <= SN[p] && SW[p, first] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) first++
  if (first > SN[p]) return
  b = base(SW[p, first])
  if (b != "echo" && b != "printf" && b != "print") return
  joined = ""
  for (j = first + 1; j <= SN[p]; j++) {
    if (b == "echo" && joined == "" && SW[p, j] ~ /^-[neE]+$/) continue
    qpush(SW[p, j], DEPTH + 1)
    joined = joined (joined == "" ? "" : " ") SW[p, j]
  }
  qpush(joined, DEPTH + 1)
}

function base(w) { sub(/.*\//, "", w); return w }

function join(from, to,    j, out) {
  out = ""
  for (j = from; j <= to; j++) out = out (j == from ? "" : " ") A[j]
  return out
}

function protected(p) {
  if (p == "" || p == "-" || p ~ /^\/dev\//) return 0
  if (p ~ /^\/(private\/)?etc(\/|$)/) return 1
  if (p ~ /^\/Library(\/|$)/) return 1
  if (p ~ /^\/System(\/|$)/) return 1
  if (p ~ /^\/(usr\/)?(s?bin|lib|lib64|libexec)(\/|$)/) return 1
  if (p ~ /^\/usr\/share(\/|$)/) return 1
  if (p ~ /^\/(boot|root)(\/|$)/) return 1
  if (p ~ /^\/(private\/)?var\/(lib|db|root)(\/|$)/) return 1
  if (p ~ /\/\.\.(\/|$)/ && p ~ /\/(etc|Library|System|usr|bin|sbin|lib|boot|root)(\/|$)/) return 1
  if (CWD_PROT && p !~ /^[\/~$]/) return 1
  return 0
}

function any_protected(from, to, what,    j) {
  for (j = from; j <= to; j++) if (A[j] !~ /^-/ && protected(A[j])) { deny(what " " A[j] " (a system path)"); return 1 }
  return 0
}

function has_arg(from, to, re,    j) {
  for (j = from; j <= to; j++) if (A[j] ~ re) return 1
  return 0
}

function check_cmd(p, k,    w, b, j, x, verb, cflag, sflag, val, nm, rp, last) {
  while (p <= AN) {
    w = A[p]
    if (w ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { nm = w; sub(/=.*/, "", nm); val = w; sub(/^[^=]*=/, "", val); VARS[nm] = val; p++; continue }
    if (w == "!" || w == "{" || w == "}" || w == "then" || w == "do" || w == "else" || w == "elif" || w == "if" || w == "while" || w == "until" || w == "fi" || w == "done" || w == "esac" || w == "coproc") { p++; continue }
    if (w == "function") { p += 2; continue }
    if (w == "for" || w == "case" || w == "select" || w == "[[" || w == "[" || w == "test") return
    if (w ~ /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/) {
      nm = w; gsub(/[${}]/, "", nm)
      if (nm in VARS) { qpush(VARS[nm] " " join(p + 1, AN), DEPTH + 1) }
      return
    }
    b = base(w)
    if (b == "export" || b == "declare" || b == "typeset" || b == "local" || b == "readonly") {
      for (j = p + 1; j <= AN; j++) if (A[j] ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { nm = A[j]; sub(/=.*/, "", nm); val = A[j]; sub(/^[^=]*=/, "", val); VARS[nm] = val }
      return
    }

    # --- escalation: never, in any position the shell will execute
    if (b ~ /^(sudo|sudoedit|visudo|su|doas|pkexec|run0|ksu|calife|dzdo|pbrun)$/) { deny("`" b "` runs a command as another user (root)"); return }

    # --- transparent wrappers: the real command follows
    if (b == "time") { p++; if (A[p] == "-p") p++; continue }
    if (b == "env") {
      p++
      while (p <= AN) {
        x = A[p]
        if (x == "--") { p++; break }
        if (x == "-u" || x == "-C" || x == "-P" || x == "--unset" || x == "--chdir") { p += 2; continue }
        if (x == "-S" || x == "--split-string") { qpush(join(p + 1, AN), DEPTH + 1); return }
        if (x ~ /^--split-string=/) { sub(/^--split-string=/, "", x); qpush(x " " join(p + 1, AN), DEPTH + 1); return }
        if (x ~ /^-/) { p++; continue }
        if (x ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { p++; continue }
        break
      }
      continue
    }
    if (b == "command") {
      p++
      while (p <= AN && A[p] ~ /^-/) { if (A[p] ~ /[vV]/) return; p++ }
      continue
    }
    if (b == "builtin" || b == "nohup" || b == "noglob" || b == "unbuffer" || b == "sem") { p++; continue }
    if (b == "exec") { p++; while (p <= AN && A[p] ~ /^-/) { if (A[p] == "-a") p++; p++ }; continue }
    if (b == "nice" || b == "renice") {
      p++
      while (p <= AN && A[p] ~ /^-/) { if (A[p] == "-n" || A[p] == "--adjustment") p++; p++ }
      continue
    }
    if (b == "ionice" || b == "chrt" || b == "taskset" || b == "stdbuf") {
      p++
      while (p <= AN && (A[p] ~ /^-/ || A[p] ~ /^(0x[0-9a-fA-F]+|[0-9][0-9,.-]*)$/)) { if (A[p] ~ /^-[cnpiotkP]$/) p++; p++ }
      continue
    }
    if (b == "timeout" || b == "gtimeout") {
      p++
      while (p <= AN && A[p] ~ /^-/) { if (A[p] == "-s" || A[p] == "-k" || A[p] == "--signal" || A[p] == "--kill-after") p++; p++ }
      p++
      continue
    }
    if (b == "caffeinate") {
      p++
      while (p <= AN && A[p] ~ /^-/) { if (A[p] == "-t" || A[p] == "-w") p++; p++ }
      continue
    }
    if (b == "xargs" || b == "gxargs") {
      p++
      while (p <= AN && A[p] ~ /^-/) {
        x = A[p]
        if (x == "--") { p++; break }
        if (x ~ /^-[ILnPsEdaRS]$/) p++
        p++
      }
      continue
    }
    if (b == "watch") {
      p++
      while (p <= AN && A[p] ~ /^-/) { if (A[p] ~ /^-[nd]$/) p++; p++ }
      qpush(join(p, AN), DEPTH + 1); return
    }
    if (b == "eval") { qpush(join(p + 1, AN), DEPTH + 1); return }
    if (b == "busybox") { p++; continue }

    # --- shells: -c strings are executed; a bare shell executes its stdin
    if (b ~ /^(sh|bash|zsh|dash|ksh|mksh|ash|yash|posh|fish)$/) {
      p++; cflag = 0; sflag = 0
      while (p <= AN && A[p] ~ /^[-+]/) {
        x = A[p]
        if (x == "--" || x == "-") { p++; break }
        if (x !~ /^--/ && x ~ /^-[A-Za-z]*c[A-Za-z]*$/) cflag = 1
        if (x !~ /^--/ && x ~ /^-[A-Za-z]*s[A-Za-z]*$/) sflag = 1
        if (x == "-o" || x == "+o" || x == "-O" || x == "+O" || x == "--rcfile" || x == "--init-file") p++
        p++
      }
      if (cflag) { if (p <= AN) qpush(A[p], DEPTH + 1); return }
      if (sflag || p > AN) { STDIN_SHELL = 1; return }
      owner_script(p)
      return
    }
    if (b == "source" || b == ".") { if (p + 1 <= AN) owner_script(p + 1); return }
    if (b ~ /^(provision|uninstall)(\.sh)?$/) { owner_script(p); return }

    # --- remote: the agent is read-only on the host; judge the remote command
    if (b == "ssh" || b == "autossh") {
      p++
      while (p <= AN) {
        x = A[p]
        if (x == "--") { p++; break }
        if (x ~ /^-[bcDEeFIiJLlmOopQRSWwBP]$/) { p += 2; continue }
        if (x ~ /^-/) { p++; continue }
        break
      }
      if (p > AN) return
      p++
      if (p > AN) { STDIN_SHELL = 1; return }
      val = join(p, AN)
      qpush(val, DEPTH + 1)
      split(val, parts, /[ \t]+/)
      if (base(parts[1]) ~ /^(sh|bash|zsh|dash|ksh)$/ && val !~ /(^|[ \t])-[A-Za-z]*c/ && (parts[2] == "" || parts[2] ~ /^-/)) STDIN_SHELL = 1
      return
    }
    if (b == "scp" || b == "rsync") {
      for (j = p + 1; j <= AN; j++) {
        x = A[j]
        if (x ~ /^--rsync-path=/) { sub(/^--rsync-path=/, "", x); qpush(x, DEPTH + 1) }
        if ((x == "-e" || x == "--rsh") && j < AN) qpush(A[j + 1], DEPTH + 1)
        if (x ~ /^--rsh=/) { sub(/^--rsh=/, "", x); qpush(x, DEPTH + 1) }
      }
      last = A[AN]
      if (last ~ /^[^\/]*:/) { rp = last; sub(/^[^:]*:/, "", rp); if (protected(rp)) { deny("copying into " rp " on a remote host (a system path)"); return } }
      else if (AN > p + 1 && protected(last)) { deny("copying into " last " (a system path)"); return }
      return
    }

    # --- launchd / systemd
    if (b == "launchctl") {
      verb = A[p + 1]
      if (verb == "config" || verb == "reboot" || verb == "asuser" || verb == "bsexec" || verb == "setenv" || verb == "unsetenv") { deny("`launchctl " verb "` changes system or other users' launchd state"); return }
      if (verb == "limit" && AN > p + 1) { deny("`launchctl limit` with values changes system limits"); return }
      if (verb ~ /^(bootstrap|bootout|kickstart|enable|disable|load|unload|remove|submit|start|stop|kill)$/) {
        for (j = p + 2; j <= AN; j++) {
          x = A[j]
          if (x ~ /^system(\/|$)/ || x ~ /^\/Library\// || x ~ /^\/System\//) { deny("`launchctl " verb " " x "` acts on the system launchd domain"); return }
          if (x ~ /^(gui|user|login|pid)\/[0-9]+(\/|$)/) { val = x; sub(/^[a-z]+\//, "", val); sub(/\/.*/, "", val); if (val != UID_SELF) { deny("`launchctl " verb " " x "` acts on another user's launchd domain"); return } }
        }
      }
      return
    }
    if (b == "systemctl") {
      if (has_arg(p + 1, AN, "^--user$")) return
      verb = ""
      for (j = p + 1; j <= AN; j++) {
        x = A[j]
        if (x ~ /^-[HMtpsnoP]$/ || x ~ /^--(host|machine|type|property|signal|lines|output|root|state|kill-whom|what)$/) { j++; continue }
        if (x ~ /^-/) continue
        verb = x; break
      }
      if (verb ~ /^(start|stop|restart|reload|try-restart|reload-or-restart|try-reload-or-restart|condrestart|force-reload|enable|disable|reenable|preset|preset-all|mask|unmask|link|revert|edit|set-property|set-default|set-environment|unset-environment|import-environment|daemon-reload|daemon-reexec|kill|clean|freeze|thaw|reset-failed|isolate|add-wants|add-requires|bind|mount-image|poweroff|reboot|halt|kexec|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|soft-reboot|default|rescue|emergency|exit|switch-root)$/) { deny("`systemctl " verb "` without --user changes system services"); return }
      return
    }
    if (b == "service" || b == "rc-service" || b == "rc-update" || b == "update-rc.d" || b == "chkconfig" || b == "initctl") { deny("`" b "` manages system services"); return }
    if (b == "loginctl") { if (A[p + 1] ~ /^(enable-linger|disable-linger|terminate-|kill-|lock-|unlock-|attach|flush-devices)/) { deny("`loginctl " A[p + 1] "` changes system login state"); return }; return }
    if (b == "journalctl") { if (has_arg(p + 1, AN, "^--(vacuum|rotate|flush|relinquish|setup-keys)")) { deny("`journalctl` maintenance changes the system journal"); return }; return }

    # --- firewall
    if (b ~ /^(pfctl|nft|iptables|ip6tables|iptables-restore|ip6tables-restore|iptables-save|ip6tables-save|iptables-legacy|iptables-nft|ebtables|arptables|ufw|firewall-cmd|socketfilterfw)$/) { deny("`" b "` changes or reads the system firewall (owner only)"); return }

    # --- users, groups, directory services
    if (b ~ /^(useradd|usermod|userdel|groupadd|groupmod|groupdel|adduser|deluser|addgroup|delgroup|chpasswd|gpasswd|passwd|vipw|vigr|newusers|chsh|chfn|createhomedir|dsenableroot|dsimport|newgrp)$/) { deny("`" b "` changes system users or groups"); return }
    if (b == "dscl") {
      if (has_arg(p + 1, AN, "^-(create|createpl|createpli|append|appendpl|appendpli|merge|mergepl|mergepli|delete|deletepl|deletepli|change|changei|passwd|auth|authonly)$")) { deny("`dscl` with a write verb changes the user directory"); return }
      if (!has_arg(p + 1, AN, "^-(read|readall|readpl|readpli|list|search|diff)$")) { deny("`dscl` without a read-only verb (interactive or write)"); return }
      return
    }
    if (b == "dseditgroup") {
      for (j = p + 1; j < AN; j++) if (A[j] == "-o" && (A[j + 1] == "read" || A[j + 1] == "checkmember")) return
      deny("`dseditgroup` without -o read|checkmember changes groups"); return
    }
    if (b == "sysadminctl") { if (has_arg(p + 1, AN, "^-secureTokenStatus$")) return; deny("`sysadminctl` changes system users"); return }
    if (b == "fdesetup") { if (A[p + 1] ~ /^(status|isactive|haspersonalrecoverykey|hasinstitutionalrecoverykey|supportsauthrestart|showdeferralinfo|usingrecoverykey|version|help)$/) return; deny("`fdesetup " A[p + 1] "` changes disk encryption"); return }
    if (b == "pmset") { if (has_arg(p + 1, AN, "^-g")) return; deny("`pmset` without -g changes power settings"); return }
    if (b == "systemsetup") { if (has_arg(p + 1, AN, "^-set")) { deny("`systemsetup -set...` changes system settings"); return }; return }
    if (b == "nvram") { if (has_arg(p + 1, AN, "=") || has_arg(p + 1, AN, "^-[dcf]$")) { deny("`nvram` write"); return }; return }
    if (b == "scutil") { if (has_arg(p + 1, AN, "^--set$")) { deny("`scutil --set` changes system names"); return }; return }
    if (b == "csrutil" || b == "spctl") { if (has_arg(p + 1, AN, "^(status|--status|-a|--assess|--list)$")) return; deny("`" b "` changes system security policy"); return }
    if (b == "mdutil") { if (has_arg(p + 1, AN, "^-[a-zA-Z]*[iEdXL]")) { deny("`mdutil` indexing changes are machine-wide and need root"); return }; return }
    if (b ~ /^(kextload|kextunload|shutdown|reboot|halt|poweroff|chroot|mount|umount|sysctl-w)$/) { deny("`" b "` is a system-level operation"); return }
    if (b == "sysctl") { if (has_arg(p + 1, AN, "=") || has_arg(p + 1, AN, "^-w$")) { deny("`sysctl` write changes kernel settings"); return }; return }
    if (b == "kmutil") { if (A[p + 1] ~ /^(load|unload|install|create|clear-staging|trigger-panic-medic)$/) { deny("`kmutil " A[p + 1] "` changes kernel extensions"); return }; return }
    if (b == "diskutil") { if (has_arg(p + 1, AN, "^(erase|partition|reformat|secureErase|zeroDisk|randomDisk|resize|apfs|cs|enableOwnership|disableOwnership|unmount|unmountDisk|mount|eject)")) { deny("`diskutil` disk change"); return }; return }
    if (b == "security") { if (A[p + 1] == "authorizationdb" && A[p + 2] != "read") { deny("`security authorizationdb` write"); return }; if (A[p + 1] ~ /^(add-trusted-cert|remove-trusted-cert)$/) { deny("`security " A[p + 1] "` changes system trust"); return }; return }
    if (b == "osascript") { val = join(p + 1, AN); if (val ~ /administrator privileges/) { deny("`osascript ... with administrator privileges` escalates"); return }; return }

    # --- immutability and ACLs
    if (b == "chflags" || b == "chattr" || b == "setfacl") { deny("`" b "` changes file flags or ACLs (owner only)"); return }
    if (b == "chmod" || b == "gchmod") {
      for (j = p + 1; j <= AN; j++) if (A[j] ~ /^[+=-]a[i#0-9]*$/ || A[j] ~ /^-[NEiI]$/) { deny("`chmod " A[j] "` edits an access-control list (owner only)"); return }
      any_protected(p + 1, AN, "changing modes on"); return
    }

    # --- writes into system paths
    if (b == "cd" || b == "pushd") { if (protected(A[p + 1])) CWD_PROT = 1; return }
    if (b ~ /^(tee|rm|rmdir|mkdir|touch|chown|chgrp|gchown|truncate|unlink|shred|srm|mkfifo)$/) { any_protected(p + 1, AN, "`" b "` on"); return }
    if (b ~ /^(cp|mv|install|ditto|ln|gcp|gmv|ginstall|gln)$/) {
      for (j = p + 1; j < AN; j++) if ((A[j] == "-t" || A[j] == "--target-directory") && protected(A[j + 1])) { deny("`" b "` into " A[j + 1] " (a system path)"); return }
      for (j = p + 1; j <= AN; j++) if (A[j] ~ /^--target-directory=/) { x = A[j]; sub(/^[^=]*=/, "", x); if (protected(x)) { deny("`" b "` into " x " (a system path)"); return } }
      if (AN > p + 1 && protected(A[AN])) { deny("`" b "` into " A[AN] " (a system path)"); return }
      return
    }
    if (b == "sed" || b == "gsed" || b == "perl") {
      if (has_arg(p + 1, AN, "^-[A-Za-z0-9]*i") || has_arg(p + 1, AN, "^--in-place")) any_protected(p + 1, AN, "editing in place")
      return
    }
    if (b == "dd") { for (j = p + 1; j <= AN; j++) if (A[j] ~ /^of=/) { x = A[j]; sub(/^of=/, "", x); if (protected(x)) { deny("`dd of=" x "` (a system path)"); return } }; return }
    if (b == "plutil") { if (has_arg(p + 1, AN, "^-(convert|insert|replace|remove|create)$")) any_protected(p + 1, AN, "`plutil` writing"); return }
    if (b == "PlistBuddy") { if (join(p + 1, AN) ~ /(Set|Add|Delete|Merge|Import|Clear|Copy) /) any_protected(p + 1, AN, "`PlistBuddy` writing"); return }
    if (b == "defaults") { if (A[p + 1] ~ /^(write|delete|import|rename)$/ && protected(A[p + 2])) { deny("`defaults " A[p + 1] " " A[p + 2] "` (system preferences)"); return }; return }
    if (b == "curl" || b == "wget") {
      for (j = p + 1; j < AN; j++) if ((A[j] == "-o" || A[j] == "--output" || A[j] == "-O" || A[j] == "--output-document" || A[j] == "-P" || A[j] == "--directory-prefix") && protected(A[j + 1])) { deny("downloading into " A[j + 1] " (a system path)"); return }
      return
    }
    if (b == "tar" || b == "gtar" || b == "bsdtar" || b == "unzip") {
      if (b == "unzip") { for (j = p + 1; j < AN; j++) if (A[j] == "-d" && protected(A[j + 1])) { deny("extracting into " A[j + 1] " (a system path)"); return }; return }
      if (A[p + 1] ~ /^-?[A-Za-z]*x/ || has_arg(p + 1, AN, "^--extract$")) {
        for (j = p + 1; j < AN; j++) if ((A[j] == "-C" || A[j] == "--directory") && protected(A[j + 1])) { deny("extracting into " A[j + 1] " (a system path)"); return }
      }
      return
    }
    if (b ~ /^(vi|vim|nvim|nano|emacs|ed|ex|pico|mcedit)$/) { any_protected(p + 1, AN, "editing"); return }
    if (b == "find") {
      for (j = p + 1; j <= AN; j++) {
        if (A[j] ~ /^-(exec|execdir|ok|okdir)$/) {
          val = ""; j++
          while (j <= AN && A[j] != ";" && A[j] != "+") { val = val (val == "" ? "" : " ") A[j]; j++ }
          qpush(val, DEPTH + 1)
        }
        if (A[j] == "-delete" && protected(A[p + 1])) { deny("`find " A[p + 1] " -delete` (a system path)"); return }
      }
      return
    }
    return
  }
}

# provision.sh / uninstall.sh are owner scripts: the agent may only dry-run them, or run the read-only
# subcommands (preflight, verify, help).
function owner_script(p,    b, j, x) {
  b = base(A[p])
  if (b !~ /^(provision|uninstall)(\.sh)?$/) return
  for (j = p + 1; j <= AN; j++) if (A[j] == "--dry-run") return
  for (j = p + 1; j <= AN; j++) {
    x = A[j]
    if (x ~ /^-/ && x !~ /^(-h|--help|--version)$/) continue
    if (x ~ /^(verify|preflight|help|-h|--help|--version)$/) return
    deny("`" b " " x "` is an owner step (it calls sudo itself): hand it to the machine owner")
    return
  }
  deny("`" b "` without --dry-run is an owner step (it calls sudo itself): hand it to the machine owner")
}

# ---------------------------------------------------------------- JSON (no-jq fallback)
function json_mode(    s, t, c) {
  s = ENVIRON["HA_JSON"]
  t = json_string_after(s, "\"tool_name\"", 1)
  c = ""
  if (index(s, "\"tool_input\"") > 0) c = json_string_after(substr(s, index(s, "\"tool_input\"")), "\"command\"", 1)
  printf "%s\n%s", t, c
}

function json_string_after(s, key, from,    i, n, c, out, h) {
  i = index(s, key)
  if (i == 0) return ""
  i += length(key); n = length(s)
  while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
  if (substr(s, i, 1) != ":") return ""
  i++
  while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
  if (substr(s, i, 1) != "\"") return ""
  i++; out = ""
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") return out
    if (c == "\\") {
      c = substr(s, i + 1, 1)
      if (c == "n") out = out "\n"
      else if (c == "t") out = out "\t"
      else if (c == "r") out = out "\r"
      else if (c == "b" || c == "f") out = out " "
      else if (c == "u") { h = hexval(substr(s, i + 2, 4)); out = out ((h >= 32 && h < 127) ? sprintf("%c", h) : (h == 10 ? "\n" : "?")); i += 4 }
      else out = out c
      i += 2; continue
    }
    out = out c; i++
  }
  return out
}

function hexval(h,    j, v, d) {
  v = 0; h = tolower(h)
  for (j = 1; j <= length(h); j++) { d = index("0123456789abcdef", substr(h, j, 1)); if (d == 0) return -1; v = v * 16 + d - 1 }
  return v
}
