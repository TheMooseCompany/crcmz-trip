// places-venues.js - the 50 Food-guide venues for the Google Places photo
// pipeline (server.js, GET /api/places/photo + /api/places/meta).
//
// Extracted 2026-10-16 from the Food cards baked into public/index.html:
// `name` is the card title, `searchQuery` is the card's own Directions
// query (name + street address / locality), and `address` is that query
// with the business name stripped. Places terms allow storing ONLY the
// place_id indefinitely, so this list holds names/addresses (public
// business facts) - never photo resource names; those are resolved
// fresh server-side and cached on disk as { placeId } only.
//
// `photoIndex` picks which of a place's photos to serve (default 0 =
// the first). Bump it for a venue whose first photo is a menu scan or
// storefront miss, then restart the app (the in-memory details cache
// also clears). `slug` is the stable client-facing key: lowercase
// name, punctuation collapsed to hyphens - the page wiring maps each
// card title through the identical slugify (see
// port-work/places-wiring.md for the full table).
module.exports = [
  { slug: "pita-basket-airdrie", name: "Pita Basket Airdrie", address: "Pita Basket 30 Market Blvd SE Airdrie AB", searchQuery: "Pita Basket 30 Market Blvd SE Airdrie AB", photoIndex: 0 },
  { slug: "tahini-s-airdrie-yankee-valley", name: "Tahini's Airdrie – Yankee Valley", address: "Tahini's 800 Yankee Valley Blvd SW Airdrie AB", searchQuery: "Tahini's 800 Yankee Valley Blvd SW Airdrie AB", photoIndex: 0 },
  { slug: "shawarma-palace-airdrie", name: "Shawarma Palace – Airdrie", address: "960 Yankee Valley Blvd SE Airdrie AB", searchQuery: "Shawarma Palace 960 Yankee Valley Blvd SE Airdrie AB", photoIndex: 0 },
  { slug: "osmow-s-shawarma-airdrie", name: "Osmow's Shawarma – Airdrie", address: "1400 Market St Airdrie AB", searchQuery: "Osmow's Shawarma 1400 Market St Airdrie AB", photoIndex: 0 },
  { slug: "villa-madina-crossiron-mills", name: "Villa Madina — CrossIron Mills", address: "CrossIron Mills Rocky View AB", searchQuery: "Villa Madina CrossIron Mills Rocky View AB", photoIndex: 0 },
  { slug: "kabob-city", name: "Kabob City", address: "10474 Cityscape Dr NE Calgary AB", searchQuery: "Kabob City 10474 Cityscape Dr NE Calgary AB", photoIndex: 0 },
  { slug: "kabob-garden-afghan-kitchen-banquet-hall", name: "Kabob Garden – Afghan Kitchen & Banquet Hall", address: "1075 Falconridge Dr NE Calgary AB", searchQuery: "Kabob Garden 1075 Falconridge Dr NE Calgary AB", photoIndex: 0 },
  { slug: "hitchki-the-grand-indian-buffet", name: "Hitchki – The Grand Indian Buffet", address: "1155 Cornerstone Blvd NE Calgary AB", searchQuery: "Hitchki 1155 Cornerstone Blvd NE Calgary AB", photoIndex: 0 },
  { slug: "hyderabad-biryani-house-calgary", name: "Hyderabad Biryani House Calgary", address: "Hyderabad Biryani House 3221 Sunridge Way NE Calgary AB", searchQuery: "Hyderabad Biryani House 3221 Sunridge Way NE Calgary AB", photoIndex: 0 },
  { slug: "apna-karachi-kitchen", name: "Apna Karachi Kitchen", address: "76 Westwinds Cres NE Calgary AB", searchQuery: "Apna Karachi Kitchen 76 Westwinds Cres NE Calgary AB", photoIndex: 0 },
  { slug: "marhaba-restaurant", name: "Marhaba Restaurant", address: "55 Westwinds Cres NE Calgary AB", searchQuery: "Marhaba Restaurant 55 Westwinds Cres NE Calgary AB", photoIndex: 0 },
  { slug: "anatolia-turkish-foods-restaurant", name: "Anatolia Turkish Foods Restaurant", address: "Anatolia Turkish Restaurant 1440 52 St NE Calgary AB", searchQuery: "Anatolia Turkish Restaurant 1440 52 St NE Calgary AB", photoIndex: 0 },
  { slug: "peshawari-kabab-hut", name: "Peshawari Kabab Hut", address: "55 Westwinds Cres NE Calgary AB", searchQuery: "Peshawari Kabab Hut 55 Westwinds Cres NE Calgary AB", photoIndex: 0 },
  { slug: "karahi-boys", name: "Karahi Boys", address: "5455 Falsbridge Dr NE Calgary AB", searchQuery: "Karahi Boys 5455 Falsbridge Dr NE Calgary AB", photoIndex: 0 },
  { slug: "cedars-deli", name: "Cedars Deli", address: "3103 Edmonton Trail NE Calgary AB", searchQuery: "Cedars Deli 3103 Edmonton Trail NE Calgary AB", photoIndex: 0 },
  { slug: "house-of-kabob", name: "House of Kabob", address: "1115 Edmonton Trail NE Calgary AB", searchQuery: "House of Kabob 1115 Edmonton Trail NE Calgary AB", photoIndex: 0 },
  { slug: "tasse-bakery-sweets", name: "Tasse Bakery & Sweets", address: "Tasse Bakery 3220 5 Ave NE Calgary AB", searchQuery: "Tasse Bakery 3220 5 Ave NE Calgary AB", photoIndex: 0 },
  { slug: "mary-brown-s-chicken-cityscape", name: "Mary Brown's Chicken — Cityscape", address: "Cityscape Dr NE Calgary AB", searchQuery: "Mary Brown's Chicken Cityscape Dr NE Calgary AB", photoIndex: 0 },
  { slug: "canadian-pizza-unlimited-westwinds", name: "Canadian Pizza Unlimited — Westwinds", address: "4818 Westwinds Dr NE Calgary AB", searchQuery: "Canadian Pizza Unlimited 4818 Westwinds Dr NE Calgary AB", photoIndex: 0 },
  { slug: "persian-plate", name: "Persian Plate", address: "340 Sage Valley Common NW Calgary AB", searchQuery: "Persian Plate 340 Sage Valley Common NW Calgary AB", photoIndex: 0 },
  { slug: "halal-pizza-and-wings-by-pizza-73", name: "Halal Pizza and Wings by Pizza 73", address: "Pizza 73 Halal 8888 Country Hills Blvd NW Calgary AB", searchQuery: "Pizza 73 Halal 8888 Country Hills Blvd NW Calgary AB", photoIndex: 0 },
  { slug: "d-spot-dessert-cafe", name: "D Spot Dessert Cafe", address: "75 Sage Hill Plaza NW Calgary AB", searchQuery: "D Spot Dessert Cafe 75 Sage Hill Plaza NW Calgary AB", photoIndex: 0 },
  { slug: "jerusalem-shawarma", name: "Jerusalem Shawarma", address: "Calgary AB", searchQuery: "Jerusalem Shawarma Calgary AB", photoIndex: 0 },
  { slug: "mazza-afghan-cuisine", name: "Mazza Afghan Cuisine", address: "237 8 Ave SE Calgary AB", searchQuery: "Mazza Afghan Cuisine 237 8 Ave SE Calgary AB", photoIndex: 0 },
  { slug: "bahar-kabab", name: "Bahar Kabab", address: "1040 12 Ave SW Calgary AB", searchQuery: "Bahar Kabab 1040 12 Ave SW Calgary AB", photoIndex: 0 },
  { slug: "cluck-n-cleaver", name: "Cluck N Cleaver", address: "1511 14 St SW Calgary AB", searchQuery: "Cluck N Cleaver 1511 14 St SW Calgary AB", photoIndex: 0 },
  { slug: "holy-shakes", name: "Holy Shakes", address: "1535 5 St SW Calgary AB", searchQuery: "Holy Shakes 1535 5 St SW Calgary AB", photoIndex: 0 },
  { slug: "taste-of-yemen", name: "Taste of Yemen", address: "1033 17 Ave SW Calgary AB", searchQuery: "Taste of Yemen 1033 17 Ave SW Calgary AB", photoIndex: 0 },
  { slug: "bereket-kebab-house", name: "Bereket Kebab House", address: "1637 37 St SW Calgary AB", searchQuery: "Bereket Kebab House 1637 37 St SW Calgary AB", photoIndex: 0 },
  { slug: "turkish-kebab-house-sw", name: "Turkish Kebab House SW", address: "Turkish Kebab House 9697 Macleod Trail SW Calgary AB", searchQuery: "Turkish Kebab House 9697 Macleod Trail SW Calgary AB", photoIndex: 0 },
  { slug: "the-food-chemist", name: "The Food Chemist", address: "156 58 Ave SW Calgary AB", searchQuery: "The Food Chemist 156 58 Ave SW Calgary AB", photoIndex: 0 },
  { slug: "my-donair-westbrook", name: "My Donair (Westbrook)", address: "My Donair 1200 37 St SW Calgary AB", searchQuery: "My Donair 1200 37 St SW Calgary AB", photoIndex: 0 },
  { slug: "taj-mahal-restaurant", name: "Taj Mahal Restaurant", address: "Macleod Trail Calgary AB", searchQuery: "Taj Mahal Restaurant Macleod Trail Calgary AB", photoIndex: 0 },
  { slug: "village-pita-bakery", name: "Village Pita Bakery", address: "255 28 St SE Calgary AB", searchQuery: "Village Pita Bakery 255 28 St SE Calgary AB", photoIndex: 0 },
  { slug: "miraj", name: "Miraj", address: "Westwinds Calgary", searchQuery: "Miraj Westwinds Calgary", photoIndex: 0 },
  { slug: "utsav-sweets-restaurant", name: "Utsav Sweets & Restaurant", address: "Westwinds Calgary", searchQuery: "Utsav Sweets & Restaurant Westwinds Calgary", photoIndex: 0 },
  { slug: "eggs-more-raja-s-cuisine", name: "Eggs & More (Raja’s Cuisine)", address: "Eggs & More Falsbridge Calgary", searchQuery: "Eggs & More Falsbridge Calgary", photoIndex: 0 },
  { slug: "chocoberry-london", name: "Chocoberry London", address: "Kensington Calgary", searchQuery: "Chocoberry London Kensington Calgary", photoIndex: 0 },
  { slug: "henzo-s-cafe", name: "Henzo’s Cafe", address: "Henzo's Cafe Savanna Calgary", searchQuery: "Henzo's Cafe Savanna Calgary", photoIndex: 0 },
  { slug: "namo-cafe-bistro", name: "Namo Cafe Bistro", address: "Edmonton Trail Calgary", searchQuery: "Namo Cafe Bistro Edmonton Trail Calgary", photoIndex: 0 },
  { slug: "shake-shack", name: "Shake Shack", address: "CF Chinook Centre Calgary", searchQuery: "Shake Shack CF Chinook Centre Calgary", photoIndex: 0 },
  { slug: "iyyc-burg", name: "IYYC Burg", address: "Bridgeland Calgary", searchQuery: "IYYC Burg Bridgeland Calgary", photoIndex: 0 },
  { slug: "shawarma-lab", name: "Shawarma Lab", address: "Woodbine Calgary", searchQuery: "Shawarma Lab Woodbine Calgary", photoIndex: 0 },
  { slug: "the-halal-guys", name: "The Halal Guys", address: "17 Ave SW Calgary", searchQuery: "The Halal Guys 17 Ave SW Calgary", photoIndex: 0 },
  { slug: "baladi-shawarma", name: "Baladi Shawarma", address: "Sage Hill Calgary", searchQuery: "Baladi Shawarma Sage Hill Calgary", photoIndex: 0 },
  { slug: "spice-bros", name: "Spice Bros", address: "17 Ave SW Calgary", searchQuery: "Spice Bros 17 Ave SW Calgary", photoIndex: 0 },
  { slug: "ginsoy-extreme-chinese", name: "Ginsoy Extreme Chinese", address: "Cityscape Calgary", searchQuery: "Ginsoy Extreme Chinese Cityscape Calgary", photoIndex: 0 },
  { slug: "spicehub-indian-kitchen-pizza", name: "SpiceHub Indian Kitchen & Pizza", address: "Northmount Dr NW Calgary", searchQuery: "SpiceHub Indian Kitchen & Pizza Northmount Dr NW Calgary", photoIndex: 0 },
  { slug: "cloud-naan", name: "Cloud Naan", address: "Cornerstone Calgary", searchQuery: "Cloud Naan Cornerstone Calgary", photoIndex: 0 },
  { slug: "taqueria-el-chefe", name: "Taqueria El Chefe", address: "Vista Heights Calgary", searchQuery: "Taqueria El Chefe Vista Heights Calgary", photoIndex: 0 },
];
