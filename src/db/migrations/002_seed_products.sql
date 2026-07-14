-- Starter catalog: real Indian kirana SKUs spanning every GST slab and loose vs packaged pricing,
-- so the bot is immediately useful without requiring the owner to add every product from scratch.

INSERT INTO products
  (sku_name, brand, unit, is_loose, hsn_code, gst_rate, price_is_tax_inclusive, cost_price, sell_price, stock_qty, reorder_level, search_aliases)
VALUES
  ('Aashirvaad Atta 5kg', 'Aashirvaad', 'packet', false, '1101', 5,  true, 235.00, 260.00, 40, 10, ARRAY['atta','aashirvaad atta','wheat flour packet']),
  ('Tata Salt 1kg',       'Tata',       'packet', false, '2501', 0,  true, 22.00,  28.00,  60, 15, ARRAY['salt','namak']),
  ('Amul Butter 100g',    'Amul',       'packet', false, '0405', 12, true, 52.00,  62.00,  30, 10, ARRAY['butter','amul butter']),
  ('Fortune Sunflower Oil 1L', 'Fortune', 'litre', false, '1512', 5, true, 155.00, 180.00, 25, 8,  ARRAY['sunflower oil','cooking oil','fortune oil']),
  ('Maggi 70g',           'Nestle',     'packet', false, '1902', 12, true, 12.00,  14.00,  100, 20, ARRAY['maggi','maggi noodles','instant noodles']),
  ('Parle-G 100g',        'Parle',      'packet', false, '1905', 5,  true, 8.00,   10.00,  120, 20, ARRAY['parle-g','parle g','glucose biscuit']),
  ('Surf Excel 1kg',      'Surf Excel', 'packet', false, '3402', 18, true, 105.00, 130.00, 20, 5,  ARRAY['surf excel','detergent','washing powder']),
  ('Sugar (loose)',       NULL,         'kg',     true,  '1701', 0,  false, 40.00,  45.00,  80, 20, ARRAY['sugar','chini']),
  ('Rice (loose)',        NULL,         'kg',     true,  '1006', 0,  false, 48.00,  55.00,  100, 25, ARRAY['rice','chawal']),
  ('Toor Dal (loose)',    NULL,         'kg',     true,  '0713', 0,  false, 105.00, 120.00, 50, 15, ARRAY['dal','toor dal','arhar dal']),
  ('Atta (loose)',        NULL,         'kg',     true,  '1101', 0,  false, 30.00,  35.00,  60, 15, ARRAY['atta','loose atta','wheat flour loose']);
