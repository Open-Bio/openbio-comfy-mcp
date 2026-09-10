"""Map ComfyUI queue/history records to prompt status and output paths."""

from __future__ import annotations

from pathlib import Path
from typing import Any

HISTORY_STATUS = {
    "success": "completed",
    "error": "error",
}
ERROR_FIELDS = ("node_id", "node_type", "exception_message", "exception_type")


def prompt_ids_from_queue_items(items: Any) -> set[str]:
    ids: set[str] = set()
    for item in items or []:
        if isinstance(item, (list, tuple)) and len(item) > 1:
            ids.add(str(item[1]))
        elif isinstance(item, dict) and item.get("prompt_id"):
            ids.add(str(item["prompt_id"]))
    return ids


def resolve_output_path(directory: str | None, subfolder: str, filename: str) -> str | None:
    if not directory or not filename:
        return None
    base = Path(directory).resolve()
    candidate = (base / subfolder / filename).resolve()
    if candidate != base and base not in candidate.parents:
        return None
    return str(candidate)


def history_status(history_entry: dict[str, Any]) -> str:
    status = history_entry.get("status")
    if not isinstance(status, dict):
        return "completed"
    return HISTORY_STATUS.get(status.get("status_str"), "completed")


def compact_history_error(history_entry: dict[str, Any]) -> dict[str, Any] | None:
    if history_status(history_entry) != "error":
        return None
    status = history_entry.get("status")
    messages = status.get("messages") if isinstance(status, dict) else None
    for entry in messages or []:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        event_name, event_data = entry[0], entry[1]
        if event_name not in ("execution_error", "execution_interrupted"):
            continue
        if not isinstance(event_data, dict):
            continue
        error = {
            key: event_data[key]
            for key in ERROR_FIELDS
            if event_data.get(key) is not None
        }
        if event_name == "execution_interrupted":
            error["interrupted"] = True
        return error
    return {}


def collect_outputs(history_entry: dict[str, Any], resolve_path) -> list[dict[str, Any]]:
    outputs: list[dict[str, Any]] = []
    raw_outputs = history_entry.get("outputs")
    if not isinstance(raw_outputs, dict):
        return outputs
    for node_id, node_output in raw_outputs.items():
        if not isinstance(node_output, dict):
            continue
        for items in node_output.values():
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                filename = str(item["filename"])
                subfolder = str(item.get("subfolder") or "")
                file_type = str(item.get("type") or "output")
                path = resolve_path(file_type, subfolder, filename)
                outputs.append({
                    "node_id": str(node_id),
                    "filename": filename,
                    "subfolder": subfolder,
                    "type": file_type,
                    **({} if path is None else {"path": path}),
                })
    return outputs


def inspect_queued_prompt(
    prompt_id: str,
    *,
    history_entry: dict[str, Any] | None,
    running_ids: set[str],
    pending_ids: set[str],
    resolve_path,
) -> dict[str, Any]:
    identity = str(prompt_id)
    if history_entry is not None:
        result = {
            "prompt_id": identity,
            "status": history_status(history_entry),
            "outputs": collect_outputs(history_entry, resolve_path),
        }
        error = compact_history_error(history_entry)
        if error is not None:
            result["error"] = error
        return result
    if identity in running_ids:
        return {"prompt_id": identity, "status": "running", "outputs": []}
    if identity in pending_ids:
        return {"prompt_id": identity, "status": "queued", "outputs": []}
    return {"prompt_id": identity, "status": "not_found", "outputs": []}


def history_entry_for(queue, prompt_id: str) -> dict[str, Any] | None:
    getter = queue.get_history
    try:
        history = getter(prompt_id=prompt_id)
    except TypeError:
        history = getter()
    if not isinstance(history, dict):
        return None
    entry = history.get(prompt_id, history.get(str(prompt_id)))
    if isinstance(entry, dict):
        return entry
    return None


def queue_item_ids(queue) -> tuple[set[str], set[str]]:
    running, pending = queue.get_current_queue()
    return prompt_ids_from_queue_items(running), prompt_ids_from_queue_items(pending)


def directory_for_type(folder_paths, file_type: str) -> str | None:
    if hasattr(folder_paths, "get_directory_by_type"):
        directory = folder_paths.get_directory_by_type(file_type)
        if directory:
            return str(directory)
    getters = {
        "output": getattr(folder_paths, "get_output_directory", None),
        "temp": getattr(folder_paths, "get_temp_directory", None),
        "input": getattr(folder_paths, "get_input_directory", None),
    }
    getter = getters.get(file_type)
    return str(getter()) if getter else None


def inspect_prompt_queue(prompt_id: str, *, queue, folder_paths) -> dict[str, Any]:
    def resolve_path(file_type: str, subfolder: str, filename: str) -> str | None:
        return resolve_output_path(directory_for_type(folder_paths, file_type), subfolder, filename)

    running_ids, pending_ids = queue_item_ids(queue)
    return inspect_queued_prompt(
        prompt_id,
        history_entry=history_entry_for(queue, prompt_id),
        running_ids=running_ids,
        pending_ids=pending_ids,
        resolve_path=resolve_path,
    )
