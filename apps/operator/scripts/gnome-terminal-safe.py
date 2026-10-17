#!/usr/bin/python3
"""Keep new Ubuntu terminals independent of an exhausted shared VTE server.

GNOME Terminal 3.52 saves its startup RLIMIT_NOFILE and restores it in the
atfork child, before VTE opens the PTY peer. Raising the running server's limit
cannot change that saved value. Start with the existing hard limit, and use
Ubuntu's supported per-window wrapper without disturbing existing windows.
"""

import os
import resource
import sys


SYSTEM_TERMINAL = "/usr/bin/gnome-terminal"


def terminal_arguments(arguments):
    # Only interpret terminal options, never options belonging to its command.
    options = arguments[:arguments.index("--")] if "--" in arguments else arguments
    grouped = any(option in ("--app-id", "--disable-factory") or
                  option.startswith("--app-id=") for option in options)
    information = any(option in ("--version", "--help", "-h") or
                      option.startswith("--help-") for option in options)
    prefix = [] if grouped or information else ["--disable-factory"]
    return [SYSTEM_TERMINAL, *prefix, *arguments]


def main(arguments=None):
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft != hard:
        resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
    os.execv(SYSTEM_TERMINAL, terminal_arguments(
        sys.argv[1:] if arguments is None else arguments))


if __name__ == "__main__":
    main()
