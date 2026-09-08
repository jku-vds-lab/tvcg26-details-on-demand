import pandas as pd
import umap
import numpy as np

# Load the smaller dataset
df = pd.read_csv("packages/app/public/data/chess_100_openings.csv")  # run from the repo root

# Assuming the opening moves are in a column named 'moves'. 
# The UMAP projection will be based on the one-hot encoded representation of the moves.
# The `chess_all_openings.csv` seems to have one-hot encoded columns already.
# Let's find them.
one_hot_cols = [col for col in df.columns if col.startswith('move_')]

if not one_hot_cols:
    print("No one-hot encoded move columns found. Please check the CSV format.")
else:
    # Project the data
    reducer = umap.UMAP(random_state=42)
    embedding = reducer.fit_transform(df[one_hot_cols])

    # Add the new coordinates to the dataframe
    df['x'] = embedding[:, 0]
    df['y'] = embedding[:, 1]

    # Save the new dataset
    output_path = "packages/app/public/data/chess_100_openings_projected.csv"
    df.to_csv(output_path, index=False)

    print(f"Projected dataset saved to {output_path}")
