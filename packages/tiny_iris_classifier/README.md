# Tiny Iris ONNX Classifier

A small end-to-end example that trains an Iris classifier in Python, exports the complete preprocessing and classification pipeline to ONNX, verifies the model with ONNX Runtime, and runs the same model in a browser with ONNX Runtime Web.

## Requirements

- Python 3.10 or newer
- Node.js 20 or newer
- npm

## Train and verify the model

```bash
cd packages/tiny_iris_classifier/training

# Use Python 3.13 or another installed Python version from 3.10 to 3.13.
python3.13 -m venv .venv
source .venv/bin/activate

python -m pip install --upgrade pip
python -m pip install -r requirements.txt

python train.py
python verify.py
```

If `python3 -m venv .venv` reports an `ensurepip` error and the virtual environment has no pip, the installed Python version is missing a working pip bootstrap. Remove the incomplete environment and create it with another installed Python version:

```bash
deactivate 2>/dev/null || true
rm -rf .venv
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

The virtual environment must be activated before running the training commands. Confirm the selected interpreter with:

```bash
which python
python --version
```

As an alternative, `uv` can create the virtual environment while still keeping the environment isolated:

```bash
uv venv --python python3.13 .venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

`train.py` creates `training/iris.onnx`. `verify.py` loads the exported model and checks that the default sample is classified as `setosa`.

Copy the model into the browser application:

```bash
cp iris.onnx ../web/public/models/iris.onnx
```

## Run the browser application

```bash
cd ../web
npm install
npm run dev
```

Open the local URL printed by Vite. The page must be served over HTTP; do not open `index.html` directly with a `file://` URL.

The default measurements are:

```text
5.1, 3.5, 1.4, 0.2
```

The default prediction should be `setosa`, with three displayed probabilities.

## Verify the production build

```bash
npm run build
npm run preview
```

The Vite configuration serves the ONNX Runtime Web WebAssembly files correctly in both development and production builds.

## Project structure

```text
tiny_iris_classifier/
├── training/
│   ├── requirements.txt
│   ├── requirements-lock.txt
│   ├── train.py
│   ├── verify.py
│   └── iris.onnx
└── web/
    ├── index.html
    ├── package.json
    ├── src/
    │   ├── main.js
    │   └── style.css
    └── public/
        └── models/
            └── iris.onnx
```
