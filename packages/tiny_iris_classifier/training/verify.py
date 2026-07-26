from pathlib import Path

import numpy as np
import onnxruntime as ort


MODEL_PATH = Path(__file__).parent / "iris.onnx"
CLASS_NAMES = ["setosa", "versicolor", "virginica"]


def main() -> None:
    session = ort.InferenceSession(
        MODEL_PATH.as_posix(),
        providers=["CPUExecutionProvider"],
    )

    print("Inputs:")
    for model_input in session.get_inputs():
        print(f"  - name={model_input.name}, shape={model_input.shape}, type={model_input.type}")
    print("Outputs:")
    for model_output in session.get_outputs():
        print(f"  - name={model_output.name}, shape={model_output.shape}, type={model_output.type}")

    sample = np.array([[5.1, 3.5, 1.4, 0.2]], dtype=np.float32)
    output_names = [output.name for output in session.get_outputs()]
    values = session.run(None, {"float_input": sample})
    outputs = dict(zip(output_names, values))

    label = int(outputs["label"][0])
    probabilities = outputs["probabilities"][0]
    print(f"Predicted label: {label}")
    print(f"Predicted class: {CLASS_NAMES[label]}")
    print(f"Probabilities: {probabilities}")

    assert label == 0, "Expected the example to be classified as setosa"
    assert probabilities.shape == (3,)
    assert np.isclose(probabilities.sum(), 1.0, atol=1e-5)
    print("Verification passed.")


if __name__ == "__main__":
    main()
