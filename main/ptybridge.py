#!/usr/bin/env python3
# Tiny PTY bridge for the LiquidDesktop Terminal.
# stdin -> pty, pty -> stdout. Resize requests arrive on fd 3 as "cols rows\n".
import os, pty, sys, select, struct, fcntl, termios, signal

cols, rows = int(sys.argv[1]), int(sys.argv[2])
cwd = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser('~')
shell = os.environ.get('SHELL') or '/bin/bash'

pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    os.environ['TERM_PROGRAM'] = 'LiquidTerminal'
    try: os.chdir(cwd)
    except Exception: pass
    # a login shell reads ~/.bash_profile / ~/.zprofile etc., like a real terminal login
    argv0 = '-' + os.path.basename(shell) if os.environ.get('LIQUID_LOGIN_SHELL') else shell
    os.environ.pop('LIQUID_LOGIN_SHELL', None)
    os.execvp(shell, [argv0])

def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
setsize(cols, rows)

ctl = 3
buf = b''
fds = [0, fd, ctl]
try:
    while True:
        r, _, _ = select.select(fds, [], [])
        if fd in r:
            try: data = os.read(fd, 65536)
            except OSError: break
            if not data: break
            os.write(1, data)
        if 0 in r:
            data = os.read(0, 65536)
            if not data: break
            os.write(fd, data)
        if ctl in r:
            data = os.read(ctl, 1024)
            if not data:
                fds.remove(ctl); continue
            buf += data
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                try:
                    c, rr = line.split()
                    setsize(int(c), int(rr))
                    os.kill(pid, signal.SIGWINCH)
                except Exception: pass
finally:
    try: os.kill(pid, signal.SIGHUP)
    except Exception: pass
