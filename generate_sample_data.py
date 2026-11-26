import numpy as np
import pandas as pd

rng = np.random.default_rng(42)

departments = ["Sales", "Marketing", "Engineering", "Finance", "Operations", "Executive Travel"]
vendors = ["Acme Supplies", "Globex Corp", "Initech", "Umbrella Co", "Staples", "Uber for Business", "Air India", "Hotel Taj"]
categories = ["Travel", "Software", "Office Supplies", "Meals", "Equipment", "Consulting"]

n = 400
dept = rng.choice(departments, size=n, p=[0.22, 0.18, 0.22, 0.13, 0.15, 0.10])
cat = rng.choice(categories, size=n)
vendor = rng.choice(vendors, size=n)

base_by_cat = {"Travel": 180, "Software": 300, "Office Supplies": 60, "Meals": 45, "Equipment": 500, "Consulting": 900}
amount = np.array([rng.normal(base_by_cat[c], base_by_cat[c] * 0.25) for c in cat])
amount = np.clip(amount, 5, None)

quantity = rng.integers(1, 6, size=n)
dates = pd.date_range("2025-01-01", periods=180, freq="D")
date = rng.choice(dates, size=n)

df = pd.DataFrame({
    "Transaction ID": [f"TXN-{10000+i}" for i in range(n)],
    "Date": pd.to_datetime(date),
    "Department": dept,
    "Vendor": vendor,
    "Category": cat,
    "Quantity": quantity,
    "Amount": np.round(amount, 2),
})

anomaly_idx = rng.choice(n, size=14, replace=False)
for i, idx in enumerate(anomaly_idx):
    if i % 3 == 0:
        # extreme spend spike, some inside the high-risk department
        df.loc[idx, "Department"] = "Executive Travel"
        df.loc[idx, "Category"] = "Travel"
        df.loc[idx, "Amount"] = round(rng.uniform(4000, 9000), 2)
    elif i % 3 == 1:
        # unusually high quantity for a low-cost category
        df.loc[idx, "Category"] = "Office Supplies"
        df.loc[idx, "Quantity"] = rng.integers(40, 90)
        df.loc[idx, "Amount"] = round(df.loc[idx, "Quantity"] * rng.uniform(15, 25), 2)
    else:
        # a plain outlier regardless of department/category
        df.loc[idx, "Amount"] = round(rng.uniform(3000, 6000), 2)

df = df.sort_values("Date").reset_index(drop=True)
df.to_excel("sample_data.xlsx", index=False, sheet_name="Expenses")
print(f"Wrote sample_data.xlsx with {len(df)} rows and {len(anomaly_idx)} seeded anomalies.")
