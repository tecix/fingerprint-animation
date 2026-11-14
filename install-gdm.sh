#!/bin/sh
# Install Fingerprint Animation for the GDM login screen.
#
#   sudo ./install-gdm.sh            install / update
#   sudo ./install-gdm.sh --remove   uninstall
#
# GDM runs its own GNOME Shell as the "gdm" user, which can't read your home
# folder and only loads system-wide extensions it has been told to enable.
# This copies the extension to /usr/share/gnome-shell/extensions (adding the
# "gdm" session mode to that copy only) and enables it in GDM's dconf
# settings. It takes effect the next time the login screen starts (log out,
# or reboot).
set -eu

UUID=fingerprint-animation@tecix
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST=/usr/share/gnome-shell/extensions/$UUID
FILES="metadata.json extension.js glyph.js stylesheet.css"

# Debian/Ubuntu: gdm3 compiles /usr/share/gdm/dconf/* on start.
DEBIAN_DCONF_DIR=/usr/share/gdm/dconf
DEBIAN_GENERATE=/usr/share/gdm/generate-config
# Fedora/Arch/upstream: profile "gdm" with system-db:gdm.
GENERIC_PROFILE=/etc/dconf/profile/gdm
GENERIC_DCONF_DIR=/etc/dconf/db/gdm.d

if [ "$(id -u)" -ne 0 ]; then
    echo "Run with sudo: sudo $0 $*" >&2
    exit 1
fi

if [ -x "$DEBIAN_GENERATE" ] && [ -d "$DEBIAN_DCONF_DIR" ]; then
    DCONF_FILE=$DEBIAN_DCONF_DIR/95-fingerprint-animation
    rebuild() { "$DEBIAN_GENERATE"; }
elif [ -f "$GENERIC_PROFILE" ] && grep -q '^system-db:gdm' "$GENERIC_PROFILE"; then
    DCONF_FILE=$GENERIC_DCONF_DIR/95-fingerprint-animation
    rebuild() { dconf update; }
else
    echo "Couldn't find GDM's dconf configuration on this system." >&2
    echo "Enable '$UUID' in org.gnome.shell enabled-extensions for the gdm user by hand." >&2
    exit 1
fi

if [ "${1:-}" = "--remove" ]; then
    rm -rf "$DEST"
    rm -f "$DCONF_FILE"
    rebuild
    echo "Removed $DEST and $DCONF_FILE"
    exit 0
fi

for f in $FILES; do
    if [ ! -f "$SRC/$f" ]; then
        echo "Missing $SRC/$f" >&2
        exit 1
    fi
done

# Don't silently override an existing GDM extension list.
if [ ! -f "$DCONF_FILE" ] &&
   grep -rqs '^\[org/gnome/shell\]' "$(dirname "$DCONF_FILE")" /etc/gdm3/greeter.dconf-defaults; then
    echo "GDM's dconf settings already have an [org/gnome/shell] section;" >&2
    echo "add '$UUID' to enabled-extensions there by hand instead." >&2
    exit 1
fi

rm -rf "$DEST"
install -d -m755 "$DEST"
for f in $FILES; do
    install -m644 "$SRC/$f" "$DEST/$f"
done
# Let this system-wide copy run on the login screen too.
sed -i 's/"unlock-dialog"/"unlock-dialog", "gdm"/' "$DEST/metadata.json"
grep -q '"gdm"' "$DEST/metadata.json"

install -d -m755 "$(dirname "$DCONF_FILE")"
cat > "$DCONF_FILE" <<CONF
# Installed by fingerprint-animation's install-gdm.sh
[org/gnome/shell]
enabled-extensions=['$UUID']
CONF
chmod 644 "$DCONF_FILE"

rebuild
echo "Installed $DEST and $DCONF_FILE"
echo "It takes effect the next time the login screen starts (log out or reboot)."
