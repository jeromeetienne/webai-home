#!/usr/bin/env bash

set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
log_directories=(
	"$script_directory/../../gateway/logs"
	"$script_directory/../logs"
)
removed_count=0

shopt -s nullglob

for logs_directory in "${log_directories[@]}"; do
	if [[ ! -d "$logs_directory" ]]; then
		continue
	fi

	for log_file in "$logs_directory"/*.log_entry.jsonl; do
		if [[ ! -f "$log_file" ]]; then
			continue
		fi

		rm -- "$log_file"
		printf 'Removed %s\n' "$log_file"
		((removed_count += 1))
	done
done

printf 'Removed %d log file(s).\n' "$removed_count"
