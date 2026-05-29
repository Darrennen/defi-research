"""
Run once to generate your Polymarket CLOB API credentials.
Set PRIVATE_KEY in polymarket_bot/.env before running.
"""
from dotenv import load_dotenv
import os

load_dotenv()

pk = os.getenv("PRIVATE_KEY")
if not pk:
    print("ERROR: Set PRIVATE_KEY in polymarket_bot/.env first")
    exit(1)

from py_clob_client.client import ClobClient
from py_clob_client.constants import POLYGON

client = ClobClient("https://clob.polymarket.com", key=pk, chain_id=POLYGON)
creds  = client.create_api_key()

print("\n=== Copy these into your Vercel environment variables ===\n")
print(f"POLYMARKET_API_KEY={creds.api_key}")
print(f"POLYMARKET_API_SECRET={creds.api_secret}")
print(f"POLYMARKET_API_PASSPHRASE={creds.api_passphrase}")
print("\n=========================================================\n")
