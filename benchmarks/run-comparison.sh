#!/bin/bash
# Benchmark comparison script: noex (TypeScript) vs Python asyncio

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "============================================"
echo "  noex vs Python asyncio Benchmark"
echo "============================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required"
    exit 1
fi

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required"
    exit 1
fi

# Build TypeScript if needed
echo "[1/4] Building TypeScript project..."
cd "$PROJECT_DIR"
if [ ! -d "dist" ] || [ "src" -nt "dist" ]; then
    npm run build 2>/dev/null || npx tsc
fi

# Compile benchmark
echo "[2/4] Compiling TypeScript benchmark..."
npx tsc "$SCRIPT_DIR/benchmark-noex.ts" --outDir "$SCRIPT_DIR/dist" \
    --module NodeNext --moduleResolution NodeNext --target ES2022 \
    --esModuleInterop --skipLibCheck 2>/dev/null || true

# Run TypeScript benchmark
echo "[3/4] Running noex (TypeScript) benchmark..."
echo ""
cd "$PROJECT_DIR"
node --experimental-specifier-resolution=node "$SCRIPT_DIR/benchmark-noex.ts" 2>/dev/null || \
    npx tsx "$SCRIPT_DIR/benchmark-noex.ts"

echo ""
echo "--------------------------------------------"
echo ""

# Run Python benchmark
echo "[4/4] Running Python asyncio benchmark..."
echo ""
python3 "$SCRIPT_DIR/benchmark_python.py"

echo ""
echo "============================================"
echo "  Comparison Complete"
echo "============================================"
echo ""
echo "Notes:"
echo "- Both implementations use similar patterns (actor model)"
echo "- TypeScript/noex uses V8 engine with optimizations"
echo "- Python uses asyncio with single-threaded event loop"
echo "- Results may vary based on system load and configuration"
