import time
from pathlib import Path

import numpy as np
import onnx
from sklearn.datasets import load_iris
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType


OUTPUT_PATH = Path(__file__).parent / "iris.onnx"
RANDOM_SEED = 42


def main() -> None:
    iris = load_iris()
    features = iris.data.astype(np.float32)
    labels = iris.target.astype(np.int64)
    print(f"Loaded dataset: {len(features)} examples, {features.shape[1]} features")

    x_train, x_test, y_train, y_test = train_test_split(
        features,
        labels,
        test_size=0.20,
        random_state=RANDOM_SEED,
        stratify=labels,
    )
    print(f"Split dataset: {len(x_train)} train, {len(x_test)} test")

    model = Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            (
                "classifier",
                LogisticRegression(max_iter=1_000, random_state=RANDOM_SEED),
            ),
        ]
    )
    print("Training started")
    training_start = time.perf_counter()
    model.fit(x_train, y_train)
    training_duration = time.perf_counter() - training_start
    print(f"Training finished in {training_duration:.3f} seconds")

    predictions = model.predict(x_test)
    accuracy = accuracy_score(y_test, predictions)
    if accuracy < 0.90:
        raise RuntimeError(f"Unexpectedly low test accuracy: {accuracy:.3f}")
    print(f"Test examples: {len(x_test)}")
    print(f"Test accuracy: {accuracy:.3f}")

    onnx_model = convert_sklearn(
        model,
        initial_types=[("float_input", FloatTensorType([None, 4]))],
        options={id(model.named_steps["classifier"]): {"zipmap": False}},
        target_opset=17,
    )
    onnx.checker.check_model(onnx_model)
    OUTPUT_PATH.write_bytes(onnx_model.SerializeToString())

    print(f"Exported model: {OUTPUT_PATH}")
    print(f"Model size: {OUTPUT_PATH.stat().st_size:,} bytes")
    print("ONNX inputs:")
    for value in onnx_model.graph.input:
        print(f"  - {value.name}")
    print("ONNX outputs:")
    for value in onnx_model.graph.output:
        print(f"  - {value.name}")


if __name__ == "__main__":
    main()
