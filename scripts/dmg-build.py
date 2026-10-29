"""dmgbuild with hdiutil's warnings kept apart (scripts/mac-build.sh dmg).

dmgbuild reads hdiutil's -plist answer from its output with stderr mixed in;
since macOS 27 hdiutil warns there that its verbs are deprecated, after the
plist, and the answer no longer parses. Here stderr goes to our own stderr.

    python3 dmg-build.py -s scripts/dmg-settings.py -D app=… -D background=… "<volume>" <out.dmg>
"""
import plistlib
import subprocess
import sys

import dmgbuild.core as core
from dmgbuild.__main__ import main


def hdiutil(cmd, *args, **kwargs):
    plist = kwargs.get('plist', True)
    command = ['/usr/bin/hdiutil', cmd, *args] + (['-plist'] if plist else [])
    p = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
    if p.stderr:
        sys.stderr.write(p.stderr.decode(errors='replace'))
    return p.returncode, plistlib.loads(p.stdout) if plist else p.stdout.decode() + p.stderr.decode(errors='replace')


core.hdiutil = hdiutil
sys.exit(main())
