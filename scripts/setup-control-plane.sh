#!/bin/bash
# Setup script for a GCP control plane VM (Ubuntu 25.10)
# Installs all language toolchains needed to run the performance matrix orchestrator.
#
# Usage (as root or with sudo):
#   bash scripts/setup-control-plane.sh
#
# After running, clone the repo and run:
#   git clone https://github.com/camunda/ts-performance-matrix.git
#   cd ts-performance-matrix && npm install
#   npx tsx src/run-matrix.ts --project YOUR_PROJECT ...

set -euo pipefail

echo "=== Installing system packages ==="
apt-get update -qq
apt-get install -y -qq curl wget git ca-certificates gnupg

# ── Node.js 22 (orchestrator + TS worker) ──
echo "=== Installing Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs
echo "  node $(node --version), npm $(npm --version)"

# ── Python 3 + pip + venv ──
echo "=== Installing Python 3 ==="
apt-get install -y -qq python3 python3-pip python3-venv
echo "  python3 $(python3 --version 2>&1 | awk '{print $2}')"

# ── uv (Python package manager) ──
echo "=== Installing uv ==="
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
echo "  uv $(uv --version 2>&1)"

# ── .NET SDK 8.0 (C# worker build) ──
echo "=== Installing .NET SDK 8.0 ==="
wget -q https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh
bash /tmp/dotnet-install.sh --channel 8.0 --install-dir /usr/share/dotnet
ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
echo "  dotnet $(dotnet --version)"

# ── JDK 21 (Java worker build — Maven not needed, the worker uses bundled mvnw) ──
echo "=== Installing JDK 21 ==="
wget -q https://download.oracle.com/java/21/latest/jdk-21_linux-x64_bin.tar.gz -O /tmp/jdk21.tar.gz
mkdir -p /opt/jdk && tar xzf /tmp/jdk21.tar.gz -C /opt/jdk --strip-components=1
cat > /etc/profile.d/jdk.sh << 'EOF'
export JAVA_HOME=/opt/jdk
export PATH=/opt/jdk/bin:$PATH
EOF
source /etc/profile.d/jdk.sh
echo "  java $(java --version 2>&1 | head -1)"

# ── Verify all tools ──
echo ""
echo "=== Verification ==="
echo "  node:    $(node --version)"
echo "  npm:     $(npm --version)"
echo "  python3: $(python3 --version 2>&1)"
echo "  uv:      $(uv --version 2>&1)"
echo "  dotnet:  $(dotnet --version)"
echo "  java:    $(java --version 2>&1 | head -1)"
echo "  git:     $(git --version)"
echo "  gcloud:  $(gcloud --version 2>&1 | head -1)"
echo ""
echo "=== Done! All toolchains installed. ==="
