import * as ort from "onnxruntime-web";
import "./style.css";

const MODEL_URL = "/models/iris.onnx";
const INPUT_NAME = "float_input";
const CLASS_NAMES = ["setosa", "versicolor", "virginica"];
// Use the same stable URL in development and production.
ort.env.wasm.wasmPaths = {
  mjs: "/ort-wasm-simd-threaded.jsep.mjs",
  wasm: "/ort-wasm-simd-threaded.jsep.wasm",
};
const statusElement = document.querySelector("#model-status");
const formElement = document.querySelector("#prediction-form");
const predictButton = document.querySelector("#predict-button");
const resultElement = document.querySelector("#result");
const predictedClassElement = document.querySelector("#predicted-class");
const probabilitiesElement = document.querySelector("#probabilities");
const inputElements = [
  document.querySelector("#sepal-length"),
  document.querySelector("#sepal-width"),
  document.querySelector("#petal-length"),
  document.querySelector("#petal-width"),
];

let session = null;

async function loadModel() {
  statusElement.textContent = "Loading…";
  try {
    session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
    if (!session.inputNames.includes(INPUT_NAME)) {
      throw new Error(`Expected input "${INPUT_NAME}", got: ${session.inputNames.join(", ")}`);
    }
    statusElement.textContent = "Ready";
    predictButton.disabled = false;
    await predict();
  } catch (error) {
    console.error(error);
    statusElement.textContent = `Failed: ${error.message}`;
  }
}

function readInputValues() {
  const values = inputElements.map((element) => Number(element.value));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("All four measurements must be valid numbers.");
  }
  return values;
}

function findOutput(outputs, preferredName, fallbackIndex) {
  if (outputs[preferredName]) return outputs[preferredName];
  return outputs[session.outputNames[fallbackIndex]];
}

async function predict() {
  if (!session) throw new Error("The model is not loaded.");
  const inputTensor = new ort.Tensor("float32", Float32Array.from(readInputValues()), [1, 4]);
  const outputs = await session.run({ [INPUT_NAME]: inputTensor });
  const label = Number(findOutput(outputs, "label", 0).data[0]);
  const probabilities = Array.from(findOutput(outputs, "probabilities", 1).data);
  renderResult(label, probabilities);
  return { label, className: CLASS_NAMES[label], probabilities };
}

function renderResult(label, probabilities) {
  predictedClassElement.textContent = CLASS_NAMES[label] ?? `unknown class ${label}`;
  probabilitiesElement.replaceChildren();
  CLASS_NAMES.forEach((className, index) => {
    const row = document.createElement("p");
    row.textContent = `${className}: ${((probabilities[index] ?? 0) * 100).toFixed(2)}%`;
    probabilitiesElement.append(row);
  });
  resultElement.hidden = false;
}

formElement.addEventListener("submit", async (event) => {
  event.preventDefault();
  predictButton.disabled = true;
  try {
    await predict();
  } catch (error) {
    console.error(error);
    window.alert(error.message);
  } finally {
    predictButton.disabled = false;
  }
});

for (const button of document.querySelectorAll(".example-button")) {
  button.addEventListener("click", async () => {
    button.dataset.values.split(",").forEach((value, index) => {
      inputElements[index].value = value;
    });
    if (session) await predict();
  });
}

loadModel();
