// Every word on the staff screens, in one place: [Hindi, English]. Hindi first, English under it.
// The wording of the approved sketches (S1-S15, 17 Oct) is used as it is. Lines marked NEW were not on a sketch
// (messages the sketches did not show): the owner checks their Hindi before go-live.
// {n}, {m}, {time}, {order}, {step} are filled in by the app.

export const S = {
  // S1 home
  app_name: ['पैकिंग प्रूफ़', 'Packing Proof'],
  home_title: ['पार्सल पर लगे कागज़ की फोटो लें', 'Take a photo of the paper on the parcel'],
  home_info: ['स्लिप हो या लेबल, ऐप खुद पहचान लेगा', 'Slip or courier label: the app works out which'],
  take_photo: ['फोटो लें', 'Take photo'],
  waiting: ['{n} फोटो भेजना बाकी, अपने आप चली जाएँगी', '{n} photos waiting, they send by themselves'],
  all_sent: ['सब फोटो भेज दी गईं', 'All photos sent'],                                         // NEW
  unfinished: ['अधूरा: {step}', 'Unfinished: {step}'],                                          // NEW
  kept_aside_n: ['{n} पार्सल अलग रखे हैं, सुपरवाइज़र देखेंगे', '{n} parcels kept aside: the supervisor will check'],   // NEW
  lock_on: ['यह फोन सिर्फ़ {step} के लिए', 'This phone: {step} only'],                           // NEW
  test_mode: ['टेस्ट', 'TEST'],                                                                  // NEW

  // S2 label or slip?
  ask_title: ['क्या पार्सल पर कूरियर लेबल लगा है?', 'Is a courier label stuck on the parcel?'],
  ask_no: ['नहीं, सिर्फ़ स्लिप है', 'No, only the packing slip'],
  ask_yes: ['हाँ, लेबल लगा है', 'Yes, the courier label is on'],
  ask_help: ['पक्का नहीं? सुपरवाइज़र को बुलाएँ', 'Not sure? Call the supervisor'],

  // stage bands
  measure_chip: ['1 नाप', 'MEASURE'],
  proof_chip: ['2 सबूत', 'PROOF'],
  measure_word: ['नाप', 'MEASURE · BEFORE BOOKING'],
  proof_word: ['सबूत', 'PROOF · AFTER BOOKING'],
  first_word: ['पहली फोटो', 'FIRST PHOTO'],                                                     // NEW
  box_n: ['बॉक्स {n}', 'Box {n}'],
  box_n_of: ['बॉक्स {n} / {m}', 'Box {n} of {m}'],

  // the photo steps (S3, S5-S8, S11)
  like_this: ['ऐसी फोटो लें', 'Take it like this'],
  slip_title: ['स्लिप की फोटो', 'Packing slip photo'],
  slip_1: ['पूरी स्लिप, सीधी, फोटो में', 'The whole slip, flat, in the photo'],
  slip_2: ['ऊपर दाईं ओर ऑर्डर नंबर साफ़ दिखे', 'Order number (top right) sharp'],
  slip_3: ['फोन करीब 25 सेमी ऊपर', 'Phone about 25 cm above'],
  weight_title: ['वज़न', 'Weight'],
  weight_1: ['पूरा पार्सल मशीन पर, कुछ भी ज़मीन से न छुए', 'Whole parcel on the scale, nothing touching the floor'],
  weight_2: ['लंबा रोल हो तो खड़ा करके रखें', 'Long roll? Stand it on its end'],
  weight_3: ['नंबर रुकने दें, डिस्प्ले और स्लिप फोटो में', 'Wait till the number stops; display and slip in the photo'],
  weight_3p: ['नंबर रुकने दें, डिस्प्ले और लेबल फोटो में', 'Wait till the number stops; display and label in the photo'],   // NEW (PROOF)
  length_title: ['लंबाई', 'Length'],
  length_1: ['एक सिरा दीवार से सटाएँ, टेप का शून्य दीवार पर', 'One end against the wall, tape zero at the wall'],
  length_2: ['दूसरे सिरे पर स्क्वायर खड़ा करें, पार्सल को छूता हुआ', 'Stand the square at the far end, just touching'],
  length_3: ['फोन स्क्वायर के ठीक ऊपर, टेप का नंबर साफ़', 'Phone right above the square, tape number sharp'],
  breadth_title: ['चौड़ाई', 'Breadth'],
  breadth_1: ['पार्सल की लंबी साइड दीवार से सटाएँ', 'Long side of the parcel against the wall'],
  breadth_2: ['टेप ऊपर से आर-पार, शून्य दीवार पर, स्क्वायर दूसरी तरफ़', 'Tape across the top, zero at the wall, square on the other side'],
  breadth_3: ['फोन स्क्वायर के ठीक ऊपर', 'Phone right above the square'],
  height_title: ['ऊँचाई', 'Height'],
  height_1: ['टेप सीधा खड़ा, शून्य ज़मीन पर', 'Tape standing straight, zero on the floor'],
  height_2: ['स्क्वायर की लंबी भुजा ऊपर, छोटी भुजा टेप से सटी', "Square's long arm on top, short arm against the tape"],
  height_3: ['फोन नंबर की ऊँचाई पर, सीधा सामने', 'Phone level with the reading, straight on'],
  label_in_view: ['लेबल भी फोटो में दिखे', 'The label in the photo too'],                       // NEW (PROOF)
  label_title: ['लेबल की फोटो', 'Label photo'],
  label_caption: ['लेबल स्लिप के ठीक बगल में, दोनों पूरे फोटो में', 'Label right next to the slip, both fully in the photo'],
  from_booking: ['ऑर्डर {order} · {n} बॉक्स', 'from the booking'],
  which_box: ['यह लेबल किस बॉक्स पर है?', 'Which box?'],
  boxes_title: ['सब बॉक्स एक फोटो में', 'All boxes in one photo'],                              // NEW
  boxes_1: ['सब बॉक्स साथ रखें, हर लेबल कैमरे की ओर', 'All boxes side by side, every label facing the camera'],   // NEW
  step_slip: ['स्लिप', 'slip'], step_label: ['लेबल', 'label'], step_scale: ['वज़न', 'weight'], step_length: ['लंबाई', 'length'],
  step_breadth: ['चौड़ाई', 'breadth'], step_height: ['ऊँचाई', 'height'], step_boxes: ['सब बॉक्स', 'all boxes'],

  // after a photo
  checking: ['जाँच हो रही है…', 'Checking…'],                                                    // NEW
  no_photo: ['कैमरे से फोटो नहीं आई, फिर से लें', 'No photo came back from the camera: take it again'],   // NEW
  saved: ['फोटो सेव हो गई', 'Photo saved'],                                                     // NEW
  next_step: ['आगे: {step}', 'Next: {step}'],
  short_beep: ['छोटी बीप', 'short beep'],

  // S4 order number read (MEASURE)
  slip_ok: ['ऑर्डर नंबर पढ़ लिया', 'Order number read'],
  only_check: ['यह सिर्फ़ जाँच है, पक्का नंबर ऑफिस देखेगा', 'This is only a check; the office confirms the number'],
  retake: ['फिर से लें', 'Retake'],
  no_reader: ['फोन पर नंबर नहीं जाँचा जा सका, फोटो सेव है', 'The phone could not check the number; the photo is saved'],   // NEW

  // S9 retake
  blurry: ['फोटो धुंधली है', 'Blurry'],
  blurry_do: ['फोन स्थिर रखें, फिर लें', 'Blurry: hold the phone still and take it again'],
  dark: ['अंधेरा है, रोशनी बढ़ाएँ', 'Too dark: more light'],
  glare: ['चमक है, फोन थोड़ा तिरछा करें', 'Glare: tilt the phone a little'],
  slip_unreadable: ['स्लिप पढ़ी नहीं गई', 'Slip not readable'],                                  // NEW
  slip_unreadable_do: ['पास से, सीधी, ज़्यादा रोशनी', 'Slip not readable: closer, flat, more light'],   // NEW
  no_barcode: ['लेबल का बारकोड नहीं पढ़ा गया', 'The label barcode did not read'],                 // NEW
  no_barcode_do: ['पास से, सीधा, ज़्यादा रोशनी', 'Closer, flat, more light'],                     // NEW
  other_box: ['यह बॉक्स {n} का लेबल है', "This is box {n}'s label"],                             // NEW
  other_box_do: ['बॉक्स {m} के लेबल की फोटो लें', "Take box {m}'s label"],                       // NEW
  old_photo: ['यह फोटो पुरानी है', 'This photo is old'],                                         // NEW
  old_photo_do: ['अभी नई फोटो लें', 'Take a new photo now'],                                     // NEW
  long_buzz: ['लंबी बज़', 'long buzz'],
  take_again: ['फिर से लें', 'Take again'],
  use_photo: ['यही फोटो रखें, सुपरवाइज़र देखेंगे', 'Use this photo; the supervisor will check'],

  // S10 box done (MEASURE)
  box_done: ['बॉक्स {n} पूरा', 'Box {n} done'],
  sending: ['{n} फोटो भेजी जा रही हैं', '{n} photos sending'],
  read_office: ['नाप ऑफिस में पढ़े जाएँगे', 'the numbers are read in the office'],
  next_box: ['इसी ऑर्डर का अगला बॉक्स', 'Next box of THIS order'],
  next_parcel: ['अगला पार्सल', 'Next parcel'],

  // MEASURE order checks (design note section 3)
  already_measured: ['यह ऑर्डर {time} बजे नापा जा चुका है', 'This order was measured at {time}'],   // NEW
  either_way: ['दोनों में शीट में दर्ज होगा', 'Either way it is marked in the Sheet'],           // NEW
  keep_aside_btn: ['अलग रखें', 'Keep aside'],                                                   // NEW
  continue_btn: ['जारी रखें', 'Continue'],                                                      // NEW
  already_booked: ['यह ऑर्डर बुक हो चुका है', 'This order is already booked'],                  // NEW
  already_booked_do: ['पहले लेबल लगाएँ, फिर फोटो लें', 'Stick the label first, then take the photo'],   // NEW
  ok: ['ठीक है', 'OK'],                                                                          // NEW

  // S12-S14 the label-slip check (PROOF)
  match: ['लेबल और स्लिप मिल गए', 'The label matches the slip'],
  slip: ['स्लिप', 'Slip'],
  label: ['लेबल', 'Label'],
  stop: ['रुकिए!', 'STOP'],
  diff_orders: ['लेबल और स्लिप अलग ऑर्डर के हैं', 'The label and the slip are for different orders'],
  not_on_slip: ['स्लिप पर यह ऑर्डर नंबर नहीं मिला', 'This order number is not on the slip'],   // NEW
  not_found: ['नहीं मिला', 'not found'],                                                         // NEW
  find_label: ['सही लेबल ढूँढें या फिर से फोटो लें', 'Find the right label, or retake the photo'],
  three_buzz: ['तीन बार बज़', 'three buzzes'],
  check_again: ['फिर से जाँचें', 'Check again'],
  fails_twice: ['दूसरी बार भी न मिले तो पार्सल अलग रखें', 'Fails twice: keep the parcel aside'],
  keep_aside: ['यह पार्सल अलग रखें', 'Keep this parcel aside'],
  sup_will_check: ['सुपरवाइज़र देखेंगे', 'The supervisor will check it'],
  marked_sheet: ['शीट में दर्ज हो गया', 'Marked in the Sheet with both photos'],
  not_booked: ['बुकिंग नहीं मिली', 'Booking not found'],                                         // NEW
  not_booked_do: ['फोटो लेते रहें, सुपरवाइज़र देखेंगे', 'Keep taking the photos; the supervisor will check'],   // NEW
  check_skipped: ['लेबल-स्लिप जाँच नहीं हो सकी', 'The label-slip check could not run'],          // NEW
  all_done: ['सब फोटो हो गईं', 'All photos done'],                                               // NEW

  // S15 supervisor
  supervisor: ['सुपरवाइज़र', 'Supervisor · PIN accepted'],
  exit: ['बाहर', 'Exit'],
  sup_awb: ['AWB टाइप करें', "Type an AWB when the barcode won't scan"],
  sup_release: ['अलग रखा पार्सल छोड़ें', 'Release a kept-aside parcel, with a reason'],
  sup_boxes: ['बॉक्स जोड़ें या हटाएँ', 'Add or remove a box by hand'],
  sup_cancel: ['रिकॉर्ड रद्द करें', 'Cancel a record; its photos are kept'],
  sup_lock: ['इस फोन की स्टेज लॉक', 'Lock this phone to one stage (two-station setup)'],
  lock_none: ['कोई नहीं', 'None'],
  sup_settings: ['सेटिंग्स और स्टेशन की', 'Settings, station key, test connection'],
  sup_logged: ['हर बदलाव शीट में दर्ज होता है', 'Every change is logged in the Sheet'],
  pin_title: ['सुपरवाइज़र PIN', 'Supervisor PIN'],                                               // NEW
  pin_wrong: ['गलत PIN', 'Wrong PIN'],                                                           // NEW
  pin_new: ['नया PIN बनाएँ', 'Set a new PIN'],                                                    // NEW
  pin_new_hint: ['सुपरवाइज़र 4 अंक का PIN चुनें', 'The supervisor picks a 4-digit PIN'],          // NEW
  pin_again: ['वही PIN फिर से डालें', 'Type the same PIN again'],                                  // NEW
  pin_mismatch: ['दोनों PIN अलग हैं, फिर से बनाएँ', 'The two PINs differ: set it again'],          // NEW
  pin_forgot: ['PIN भूल गए? स्टेशन की डालें', 'Forgot the PIN? Enter the station key'],           // NEW
  key_wrong: ['स्टेशन की गलत है', 'Wrong station key'],                                          // NEW
};

const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v && v[k] !== undefined ? v[k] : ''));

// {hi, en} for one key, with the {placeholders} filled in.
export function t(key, vars) {
  const p = S[key];
  if (!p) throw new Error('no words for ' + key);
  return { hi: fill(p[0], vars), en: fill(p[1], vars) };
}
