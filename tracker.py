import os
import re
import requests
from bs4 import BeautifulSoup
import gspread
from datetime import datetime

SHEET_NAME = "Moxfield Value Tracker"

DECKS_TO_TRACK = [
    {"name": "villain kindred", "id": "l8aeASsn2Xae-Tfg_2qO8w"},
    {"name": "thethiroth", "id": "aAgrxPiY20KtGDwcfNKpVw"},
    {"name": "squallsac", "id": "epXXpnS0fUiiz6Z4lADS6A"},
    {"name": "it just dawned on me", "id": "9yCc7l6xD0SIBmubW1R1ng"},
    {"name": "I scry..... you know the drill", "id": "yHl4UHI1zEGfHNss_e2Stg"},
    {"name": "heads chaos, tails chaos", "id": "DDkjxw1jIE2aQk5CvElQiA"},
    {"name": "can i borrow that?", "id": "j4tPXwOZY0Ggfwzr8ndosg"},
    {"name": "blight witch", "id": "bJYLz4H2-ke8kHTQKuyhXQ"},
    {"name": '˜"°•✿•°"˜ 𝔂𝓾𝓷𝓪 ˜"°•✿•°"˜', "id": "0j0GzpMT_UyEgyS_RUuQEg"},
    {"name": "（︶O︶） 𝔪𝔦𝔩𝔩 （︶-︶）", "id": "sUIPhuC0qkOnXdR3VmeI_g"}
]


def track_portfolio():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    credentials_path = os.path.join(script_dir, "credentials.json")

    if not os.path.exists(credentials_path):
        print(f"\n[!] ERROR: Missing credentials.json\n")
        return

    print("Scraping deck pages silently (No browsers, no background processes)...")
    deck_valuations = []

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    for deck in DECKS_TO_TRACK:
        url = f"https://www.moxfield.com/decks/{deck['id']}"

        try:
            response = requests.get(url, headers=headers)
            if response.status_code == 200:
                # Parse the raw HTML text of the page
                soup = BeautifulSoup(response.text, 'html.parser')

                # Find your exact element ID #shoppingcart
                cart_element = soup.find(id="shoppingcart")

                val = 0.0
                if cart_element:
                    cart_text = cart_element.get_text()
                    match = re.search(r'\$([\d,]+\.\d{2})', cart_text)
                    if match:
                        val = float(match.group(1).replace(',', ''))

                deck_valuations.append({"name": deck['name'], "value": val})
                print(f"  -> {deck['name']}: ${val:.2f}")
            else:
                print(f"  -> Failed to fetch {deck['name']} (Status: {response.status_code})")

        except Exception as e:
            print(f"  -> Error parsing {deck['name']}: {e}")

    if not deck_valuations:
        print("\nNo values retrieved.")
        return

    print("\nConnecting to Google Sheets...")
    gc = gspread.service_account(filename=credentials_path)
    sheet = gc.open(SHEET_NAME).worksheet("Log")

    dt = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    for d in deck_valuations:
        sheet.append_row([dt, d['name'], d['value']])
        print(f"Logged: {d['name']} - ${d['value']:.2f}")

    print("\nDone!")


if __name__ == "__main__":
    track_portfolio()