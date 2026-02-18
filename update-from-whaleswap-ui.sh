#!/bin/bash

# =============================================================================
# UPDATE FROM WHALESWAP-UI SCRIPT
# =============================================================================
#
# PURPOSE: This script updates whaleswap.github.io by copying files from
#          WhaleSwap-UI and updating version numbers.
#
# PREREQUISITES:
# 1. This script must be located in the whaleswap.github.io directory
# 2. The WhaleSwap-UI repository must be in the same parent directory as whaleswap.github.io
#    example structure:
#    /path/to/parent/
#    ├── whaleswap.github.io/     (this repo, contains this script)
#    └── WhaleSwap-UI/            (source repo)
# 3. The script must have execute permissions: chmod +x update-from-whaleswap-ui.sh
#
# USAGE:
# 1. Run the script from anywhere: ./update-from-whaleswap-ui.sh
#    (or: cd whaleswap.github.io && ./update-from-whaleswap-ui.sh)
#
# WHAT IT DOES:
# - Copies all files from WhaleSwap-UI/* to whaleswap.github.io/
# - Excludes node_modules, .git, .vscode, .env, artifacts, cache, docs, etc.
# - Increments patch version in index.html (e.g., v1.0.25 -> v1.0.26)
# - Updates version.html with current timestamp
#
# =============================================================================

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The script should be in whaleswap.github.io, so that's our repo root (target)
REPO_DIR="$SCRIPT_DIR"

# Source directory is in the sibling WhaleSwap-UI directory
SOURCE_DIR="$(dirname "$REPO_DIR")/WhaleSwap-UI"

# Target directory is the repo root (whaleswap.github.io)
TARGET_DIR="$REPO_DIR"

# Change to the repo directory
cd "$REPO_DIR" || exit 1

# Check if source directory exists
if [ ! -d "$SOURCE_DIR" ]; then
    echo "Error: Source directory not found: $SOURCE_DIR"
    echo "Please ensure WhaleSwap-UI is in the same parent directory as whaleswap.github.io"
    exit 1
fi

# Check if source directory is empty
if [ -z "$(ls -A "$SOURCE_DIR")" ]; then
    echo "Error: Source directory is empty: $SOURCE_DIR"
    exit 1
fi

# Extract the current version from index.html (BEFORE copying)
# Format: <span class="version">v1.0.25</span>
if [ -f "$TARGET_DIR/index.html" ]; then
    current_version=$(grep -oP "(?<=<span class=\"version\">v)[^<]+" "$TARGET_DIR/index.html" | head -1)
else
    current_version="1.0.0"
fi

# Increment the patch version (e.g., 1.0.25 -> 1.0.26)
if [[ $current_version =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    patch="${BASH_REMATCH[3]}"
    new_patch=$((patch + 1))
    new_version="${major}.${minor}.${new_patch}"
else
    new_version="1.0.1"
fi

echo "Copying WhaleSwap-UI contents to whaleswap.github.io..."
echo "Source: $SOURCE_DIR"
echo "Target: $TARGET_DIR"

# Use rsync to copy files while excluding build artifacts and dev tooling
# Exclude this script and .git to avoid overwriting the target repo metadata
rsync -av \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.idea' \
  --exclude='.vscode' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='artifacts' \
  --exclude='cache' \
  --exclude='delete_when_done' \
  --exclude='deprecated' \
  --exclude='.playwright-mcp' \
  --exclude='docs' \
  --exclude='update-from-whaleswap-ui.sh' \
  --exclude='update-dev-client.sh' \
  --exclude='CNAME' \
  "$SOURCE_DIR/" "$TARGET_DIR/"

echo "Removing unwanted folders..."
rm -rf "$TARGET_DIR/.vscode"

# Update the version in the newly copied index.html
sed -i -E "s|<span class=\"version\">v[0-9]+\.[0-9]+\.[0-9]+</span>|<span class=\"version\">v$new_version</span>|" "$TARGET_DIR/index.html"

# Get the current date and time for version.html
current_date=$(date +"%Y.%m.%d.%H.%M")

# Update the version in version.html
echo "$current_date" > "$TARGET_DIR/version.html"

# Debugging output
echo "Current directory: $(pwd)"
echo "New version in index.html: v$new_version"
echo "New version in version.html: $current_date"

# Check if files exist
if [ ! -f "$TARGET_DIR/index.html" ]; then
    echo "Error: index.html not found"
    exit 1
fi

if [ ! -f "$TARGET_DIR/version.html" ]; then
    echo "Error: version.html not found"
    exit 1
fi

# Check permissions
if [ ! -w "$TARGET_DIR/index.html" ]; then
    echo "Error: No write permission for index.html"
    exit 1
fi

if [ ! -w "$TARGET_DIR/version.html" ]; then
    echo "Error: No write permission for version.html"
    exit 1
fi

echo "Update completed successfully!"
