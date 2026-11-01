// Public packaging identity, NOT an API credential. Keep stable across builds:
// changing it changes the browser profile/storage and OAuth redirect URL.
// Signing private material must never be committed or shipped.
export const CHROME_PUBLIC_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxh6StIKmfPEw4xbo0Ri+LzmXYUhKilq6gI2wmuhEfhBECT28zPUotAJpN4cIGX6lcMdTiaEQUDOoQvv44ufiRare+C3LaerTnD0JoEeNNwC6Lw/618JmVAyVBeAvq6yFOoZNxu5uuNBSwv8sc/CHTGrT54sjWI3eGcJSF/3PPfYP/EB4qu/ipfW27eS2yTfjmW6GMWYSfkAcGZDs4CciXF5jJj46aHZ2ziYTDqm09JyJQLnZZTDEpAA2u7mOXryQLGKl9tYhmuS21oNjjX1QZH0wqukOO0LD3LpsJwpcxMftTG4tU4kEBnGefl9FWxh7nhEpE4Wztp6MGSeQSgEDQwIDAQAB";
export const CHROME_EXTENSION_ID = "fmalikgllmcngknlmiepcoogalacikmb";
export const FIREFOX_EXTENSION_ID = "cairn-capture@alpenl.com";
