import urllib.request
import json

url = "https://api.moxfield.com/v2/decks/all/l8aeASsn2Xae-Tfg_2qO8w"
headers = {'User-Agent': 'Mozilla/5.0'}

try:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))

    print("--- FIRST LEVEL KEYS ---")
    print(list(data.keys()))

    print("\n--- LOOKING FOR PRICE KEYWORDS ---")
    for key, val in data.items():
        if 'price' in key.lower() or 'value' in key.lower() or 'market' in key.lower():
            print(f"Found Key: '{key}' -> Type: {type(val)}")
            if isinstance(val, dict):
                print(f"  Sub-keys: {list(val.keys())}")
            else:
                print(f"  Value: {val}")

except Exception as e:
    print(f"Error checking layout: {e}")