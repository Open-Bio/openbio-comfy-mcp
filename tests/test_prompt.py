from pathlib import Path

from openbio_comfy_mcp.prompt import (
    inspect_prompt_queue,
    inspect_queued_prompt,
    prompt_ids_from_queue_items,
    resolve_output_path,
)


class FakeFolderPaths:
    def __init__(self, output: Path) -> None:
        self._output = output

    def get_directory_by_type(self, file_type: str) -> str | None:
        if file_type == "output":
            return str(self._output)
        return None


class FakeQueue:
    def __init__(self, *, running=None, pending=None, history=None) -> None:
        self._running = running or []
        self._pending = pending or []
        self._history = history or {}

    def get_current_queue(self):
        return self._running, self._pending

    def get_history(self, prompt_id=None):
        if prompt_id is None:
            return self._history
        if prompt_id in self._history:
            return {prompt_id: self._history[prompt_id]}
        return {}


def test_queue_item_prompt_ids_read_tuple_and_dict_shapes():
    assert prompt_ids_from_queue_items([
        (1, "running-1", {}, {}, []),
        {"prompt_id": "running-2"},
    ]) == {"running-1", "running-2"}


def test_resolve_output_path_joins_and_rejects_escapes(tmp_path):
    output = tmp_path / "output"
    nested = output / "runs"
    nested.mkdir(parents=True)
    (nested / "out.png").write_bytes(b"x")
    (tmp_path / "secret.txt").write_text("no")

    assert resolve_output_path(str(output), "runs", "out.png") == str((nested / "out.png").resolve())
    assert resolve_output_path(str(output), "..", "secret.txt") is None


def test_inspect_queued_prompt_status_and_outputs(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    history = {
        "outputs": {
            "9": {
                "images": [{
                    "filename": "out.png",
                    "subfolder": "",
                    "type": "output",
                }],
                "text": ["ignore me"],
            }
        }
    }

    def resolve_path(file_type, subfolder, filename):
        assert file_type == "output"
        return resolve_output_path(str(output), subfolder, filename)

    completed = inspect_queued_prompt(
        "prompt-9",
        history_entry=history,
        running_ids=set(),
        pending_ids=set(),
        resolve_path=resolve_path,
    )
    assert completed["status"] == "completed"
    assert completed["outputs"] == [{
        "node_id": "9",
        "filename": "out.png",
        "subfolder": "",
        "type": "output",
        "path": str((output / "out.png").resolve()),
    }]
    assert inspect_queued_prompt(
        "prompt-9",
        history_entry=None,
        running_ids={"prompt-9"},
        pending_ids=set(),
        resolve_path=resolve_path,
    )["status"] == "running"
    assert inspect_queued_prompt(
        "prompt-9",
        history_entry=None,
        running_ids=set(),
        pending_ids={"prompt-9"},
        resolve_path=resolve_path,
    )["status"] == "queued"
    assert inspect_queued_prompt(
        "prompt-9",
        history_entry=None,
        running_ids=set(),
        pending_ids=set(),
        resolve_path=resolve_path,
    )["status"] == "not_found"


def test_inspect_queued_prompt_maps_history_error_without_calling_it_completed():
    history = {
        "outputs": {},
        "status": {
            "status_str": "error",
            "completed": False,
            "messages": [
                ["execution_error", {
                    "node_id": "9",
                    "node_type": "KSampler",
                    "exception_message": "CUDA out of memory",
                    "exception_type": "RuntimeError",
                    "traceback": ["ignored"],
                    "current_inputs": {"huge": True},
                }],
            ],
        },
    }

    result = inspect_queued_prompt(
        "prompt-9",
        history_entry=history,
        running_ids=set(),
        pending_ids=set(),
        resolve_path=lambda *_: None,
    )

    assert result == {
        "prompt_id": "prompt-9",
        "status": "error",
        "outputs": [],
        "error": {
            "node_id": "9",
            "node_type": "KSampler",
            "exception_message": "CUDA out of memory",
            "exception_type": "RuntimeError",
        },
    }


def test_inspect_prompt_queue_reads_comfy_queue_and_folder_paths(tmp_path):
    output = tmp_path / "output"
    output.mkdir()
    queue = FakeQueue(
        running=[(0, "running-1", {}, {}, [])],
        pending=[(1, "queued-1", {}, {}, [])],
        history={
            "prompt-9": {
                "outputs": {
                    "3": {"images": [{"filename": "done.png", "subfolder": "", "type": "output"}]}
                }
            }
        },
    )
    folder_paths = FakeFolderPaths(output)

    assert inspect_prompt_queue("running-1", queue=queue, folder_paths=folder_paths)["status"] == "running"
    assert inspect_prompt_queue("queued-1", queue=queue, folder_paths=folder_paths)["status"] == "queued"
    done = inspect_prompt_queue("prompt-9", queue=queue, folder_paths=folder_paths)
    assert done["status"] == "completed"
    assert done["outputs"][0]["path"] == str((output / "done.png").resolve())
    assert inspect_prompt_queue("missing", queue=queue, folder_paths=folder_paths)["status"] == "not_found"
