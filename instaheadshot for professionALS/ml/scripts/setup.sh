#!/bin/bash
# ============================================================
# InstaHeadshot — Local M4 Training Setup
# Run this once to set up your Mac for local LoRA training.
# ============================================================

set -e

echo "=========================================="
echo "InstaHeadshot Local Training Setup"
echo "=========================================="
echo ""

# Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo "WARNING: This script is designed for macOS (Apple Silicon)."
    echo "You can still proceed, but MPS backend won't be available."
fi

# Check Apple Silicon
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
    echo "✓ Apple Silicon detected ($ARCH)"
else
    echo "WARNING: Expected Apple Silicon (arm64), got $ARCH"
    echo "MPS acceleration may not work."
fi

# Check Python
echo ""
echo "Checking Python..."
if command -v python3 &>/dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    echo "✓ Found $PYTHON_VERSION"
else
    echo "✗ Python 3 not found. Install from https://python.org or via Homebrew:"
    echo "  brew install python@3.11"
    exit 1
fi

# Create virtual environment
echo ""
echo "Creating virtual environment..."
VENV_DIR="$(cd "$(dirname "$0")/.." && pwd)/.venv"

if [ -d "$VENV_DIR" ]; then
    echo "Virtual environment already exists at $VENV_DIR"
    echo "To recreate, delete it first: rm -rf $VENV_DIR"
else
    python3 -m venv "$VENV_DIR"
    echo "✓ Created virtual environment at $VENV_DIR"
fi

# Activate
source "$VENV_DIR/bin/activate"

# Upgrade pip
echo ""
echo "Upgrading pip..."
pip install --upgrade pip

# Install PyTorch with MPS support
echo ""
echo "Installing PyTorch (with MPS support for Apple Silicon)..."
pip install torch torchvision torchaudio

# Install Hugging Face libraries
echo ""
echo "Installing diffusers + transformers + PEFT..."
pip install \
    diffusers[torch]>=0.28.0 \
    transformers>=4.40.0 \
    accelerate>=0.30.0 \
    peft>=0.11.0 \
    safetensors \
    sentencepiece \
    protobuf

# Install image processing
echo ""
echo "Installing image processing libraries..."
pip install \
    Pillow>=10.0 \
    opencv-python-headless

# Verify MPS
echo ""
echo "Verifying MPS (Metal Performance Shaders) availability..."
python3 -c "
import torch
print(f'PyTorch version: {torch.__version__}')
print(f'MPS available: {torch.backends.mps.is_available()}')
print(f'MPS built: {torch.backends.mps.is_built()}')
if torch.backends.mps.is_available():
    # Quick test
    x = torch.randn(2, 3, device='mps')
    y = x * 2
    print(f'MPS compute test: PASSED')
    print(f'Your Mac is ready for local LoRA training!')
else:
    print('WARNING: MPS not available. Training will fall back to CPU.')
"

# Create data directories
echo ""
echo "Creating data directories..."
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data"
mkdir -p "$DATA_DIR/models"
mkdir -p "$DATA_DIR/outputs"
mkdir -p "$DATA_DIR/uploads"
echo "✓ Created $DATA_DIR/{models,outputs,uploads}"

# Initialize the job queue database
echo ""
echo "Initializing job queue..."
python3 -c "
import sys
sys.path.insert(0, '$(cd "$(dirname "$0")/.." && pwd)/job_runner')
from job_queue import init_db
init_db()
print('✓ Job queue database initialized')
"

echo ""
echo "=========================================="
echo "Setup complete!"
echo "=========================================="
echo ""
echo "To start the system:"
echo ""
echo "  1. Activate the virtual environment:"
echo "     source $VENV_DIR/bin/activate"
echo ""
echo "  2. Start the API server (in one terminal):"
echo "     python $(cd "$(dirname "$0")/.." && pwd)/job_runner/job_queue.py api"
echo ""
echo "  3. Start the worker (in another terminal):"
echo "     python $(cd "$(dirname "$0")/.." && pwd)/job_runner/job_queue.py worker"
echo ""
echo "  4. Your Next.js app can now POST to http://127.0.0.1:8420/api/train"
echo ""
echo "  5. Download the Flux model (first run only — ~12GB):"
echo "     The model downloads automatically on first training job."
echo "     Make sure you have a Hugging Face account and have accepted"
echo "     the Flux license at https://huggingface.co/black-forest-labs/FLUX.1-dev"
echo ""
