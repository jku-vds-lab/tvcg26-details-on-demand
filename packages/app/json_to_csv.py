#!/usr/bin/env python3
import json
import csv
import sys

def main(input_file, output_file):
    # Load the JSON data
    with open(input_file, 'r') as f:
        data = json.load(f)

    nodes = data.get('nodes', [])
    
    # Define constant values for 'label' and 'algo'
    constant_label = "default_label"
    constant_algo = "default_algo"
    
    # Define invented annotations for further use
    constant_state_annotation = "default_state"
    constant_next_action_annotation = "default_next_action"
    
    # Define CSV columns.
    # Order: step, line, label, algo, x, y, state_annotation, next_action_annotation.
    fieldnames = [
        'step',
        'line',
        'label',
        'algo',
        'x',
        'y',
        'state_annotation',
        'next_action_annotation'
    ]
    
    # Write out CSV rows for each node in the JSON data.
    with open(output_file, 'w', newline='') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        for node in nodes:
            # Map the JSON fields to the CSV format
            row = {
                'step': node.get('time'),
                'line': node.get('trajectory'),
                'label': constant_label,
                'algo': constant_algo,
                'x': node.get('coordinate', {}).get('x'),
                'y': node.get('coordinate', {}).get('y'),
                'state_annotation': constant_state_annotation,
                'next_action_annotation': constant_next_action_annotation
            }
            writer.writerow(row)

if __name__ == '__main__':
    # Expect input and output file names as command-line arguments
    if len(sys.argv) != 3:
        print("Usage: {} input_file.json output_file.csv".format(sys.argv[0]))
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
