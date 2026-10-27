# dmgbuild's settings for the Mac disk image (scripts/mac-build.sh dmg): the
# app beside a link to /Applications over docs/brand/dmg-background, so it is
# installed by dragging one onto the other. The icon positions are the ones
# docs/brand/make-dmg-background.py draws its arrow between. The .app extension is
# left to Finder, which hides it anyway: hide_extensions would set the bundle's
# Finder info, which codesign --strict refuses.
#
#   dmgbuild -s scripts/dmg-settings.py -D app=<CicaTavern.app> -D background=<tiff> "<volume name>" <out.dmg>
import os.path

app = defines['app']  # noqa: F821 (dmgbuild provides `defines`)
appname = os.path.basename(app)

files = [app]
symlinks = {'Applications': '/Applications'}
icon = os.path.join(app, 'Contents', 'Resources', 'CicaTavern.icns')

format = 'ULFO'  # lzfse: macOS 10.11 and later, smaller than zlib
filesystem = 'HFS+'

background = defines['background']  # noqa: F821
window_rect = ((200, 120), (660, 400))
default_view = 'icon-view'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
include_icon_view_settings = True

icon_size = 128
text_size = 13
icon_locations = {
    appname: (170, 196),
    'Applications': (490, 196),
}
