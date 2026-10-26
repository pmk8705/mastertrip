// 오프라인 회화 카드 문장 (현지인에게 화면을 보여 주는 용도).
// 인사·식당·숙소·교통 = Gemini 작성(2026-10-26, 'favor' 발음만 '파보르'로 고침). 쇼핑·긴급 = Claude 초안, 같은 날 Gemini가 8문장 추가.
// cat 분류, es 스페인어, en 영어(스페인어 모르는 직원용), ko 한국어 뜻, say 한글 발음
const PHRASES = {
  es: [
    { cat: '인사', es: '¡Hola!', en: 'Hello!', ko: '안녕하세요!', say: '올라!' },
    { cat: '인사', es: 'Buenos días. / Buenas tardes.', en: 'Good morning. / Good afternoon.', ko: '좋은 아침/오후입니다.', say: '부에노스 디아스 / 부에나스 따르데스' },
    { cat: '인사', es: 'Gracias. / Perdón.', en: 'Thank you. / Excuse me (Sorry).', ko: '감사합니다. / 죄송합니다(실례합니다).', say: '그라시아스 / 뻬르돈' },
    { cat: '인사', es: '¿Habla inglés?', en: 'Do you speak English?', ko: '영어를 하실 줄 아나요?', say: '아블라 잉글레스?' },
    { cat: '인사', es: 'No entiendo.', en: "I don't understand.", ko: '이해하지 못했어요.', say: '노 엔띠엔도' },

    { cat: '식당', es: 'La carta, por favor.', en: 'The menu, please.', ko: '메뉴판 부탁드립니다.', say: '라 까르따, 뽀르 파보르' },
    { cat: '식당', es: 'Agua sin gas, por favor.', en: 'Still water, please.', ko: '탄산 없는 일반 생수 부탁드립니다.', say: '아구아 신 가스, 뽀르 파보르' },
    { cat: '식당', es: '¿Tienen menú en inglés?', en: 'Do you have an English menu?', ko: '영어 메뉴판이 있나요?', say: '띠에넨 메누 엔 잉글레스?' },
    { cat: '식당', es: 'Poca sal, por favor.', en: 'Less salt, please.', ko: '소금은 조금만(덜 짜게) 넣어주세요.', say: '뽀까 살, 뽀르 파보르' },
    { cat: '식당', es: '¡Qué rico!', en: "It's very delicious!", ko: '정말 맛있어요!', say: '께 리꼬!' },
    { cat: '식당', es: 'La cuenta, por favor.', en: 'The bill, please.', ko: '계산서 부탁드립니다.', say: '라 꾸엔따, 뽀르 파보르' },
    { cat: '식당', es: 'Para llevar, por favor.', en: 'To go, please.', ko: '포장해 주세요.', say: '빠라 예바르, 뽀르 파보르' },

    { cat: '숙소', es: '¿Puede guardar nuestro equipaje?', en: 'Can you keep our luggage?', ko: '저희 짐을 좀 맡길 수 있을까요?', say: '뿌에데 구아르다르 누에스트로 에끼빠헤?' },
    { cat: '숙소', es: 'El Wi-Fi / el aire acondicionado no funciona.', en: 'The Wi-Fi / air conditioner is not working.', ko: '와이파이 / 에어컨이 작동하지 않아요.', say: '엘 와이파이 / 엘 아이레 아꼰디시오나도 노 푼시오나' },
    { cat: '숙소', es: '¿Podría darnos más toallas, por favor?', en: 'Could you give us more towels, please?', ko: '수건을 좀 더 주시겠어요?', say: '뽀드리아 다르노스 마스 또아야스, 뽀르 파보르' },
    { cat: '숙소', es: '¿Podría llamarnos un taxi?', en: 'Could you call a taxi for us?', ko: '택시를 좀 불러주실 수 있나요?', say: '뽀드리아 야마르노스 운 딱시?' },
    { cat: '숙소', es: 'Quiero hacer el check-out.', en: 'I would like to check out.', ko: '체크아웃하고 싶습니다.', say: '끼에로 아세르 엘 체크아웃' },

    { cat: '교통', es: 'A esta dirección, por favor.', en: 'To this address, please.', ko: '이 주소로 가주세요.', say: '아 에스따 디렉시온, 뽀르 파보르' },
    { cat: '교통', es: 'Pare aquí, por favor.', en: 'Stop here, please.', ko: '여기서 세워주세요.', say: '빠레 아끼, 뽀르 파보르' },
    { cat: '교통', es: '¿Dónde está la parada de taxis / la estación de tren?', en: 'Where is the taxi stand / train station?', ko: '택시 승강장 / 기차역이 어디인가요?', say: '돈데 에스따 라 빠라다 데 딱시스 / 라 에스따시온 데 뜨렌?' },
    { cat: '교통', es: 'Dos billetes, por favor.', en: 'Two tickets, please.', ko: '표 2장 부탁드립니다.', say: '도스 비예떼스, 뽀르 파보르' },
    { cat: '교통', es: '¿A qué hora sale?', en: 'What time does it leave?', ko: '몇 시에 출발하나요?', say: '아 께 오라 살레?' },

    { cat: '쇼핑', es: '¿Cuánto cuesta?', en: 'How much is it?', ko: '얼마예요?', say: '꾸안또 꾸에스따?' },
    { cat: '쇼핑', es: '¿Puedo pagar con tarjeta?', en: 'Can I pay by card?', ko: '카드로 계산할 수 있나요?', say: '뿌에도 빠가르 꼰 따르헤따?' },
    { cat: '쇼핑', es: '¿Puedo probarme esto?', en: 'Can I try this on?', ko: '이거 입어봐도 되나요?', say: '뿌에도 쁘로바르메 에스또?' },
    { cat: '쇼핑', es: 'Tax free, por favor.', en: 'Tax-free form, please.', ko: '택스프리(세금 환급) 서류 부탁드립니다.', say: '딱스 프리, 뽀르 파보르' },
    { cat: '쇼핑', es: 'Solo estoy mirando, gracias.', en: "I'm just looking, thank you.", ko: '그냥 둘러보는 중이에요, 고마워요.', say: '솔로 에스또이 미란도, 그라시아스' },

    { cat: '긴급', es: '¡Ayuda!', en: 'Help!', ko: '도와주세요!', say: '아유다!' },
    { cat: '긴급', es: 'Llame a la policía, por favor.', en: 'Please call the police.', ko: '경찰을 불러 주세요.', say: '야메 아 라 뽈리시아, 뽀르 파보르' },
    { cat: '긴급', es: 'Necesito un médico.', en: 'I need a doctor.', ko: '의사가 필요해요.', say: '네세시또 운 메디꼬' },
    { cat: '긴급', es: '¿Dónde está el hospital más cercano?', en: 'Where is the nearest hospital?', ko: '가장 가까운 병원이 어디예요?', say: '돈데 에스따 엘 오스삐딸 마스 쎄르까노?' },
    { cat: '긴급', es: '¿Dónde está la farmacia más cercana?', en: 'Where is the nearest pharmacy?', ko: '가장 가까운 약국이 어디인가요?', say: '돈데 에스따 라 파르마시아 마스 쎄르까나?' },
    { cat: '긴급', es: 'Me han robado la cartera / el móvil.', en: 'My wallet / phone has been stolen.', ko: '지갑을 / 휴대폰을 도난당했어요.', say: '메 안 로바도 라 까르떼라 / 엘 모빌' },
    { cat: '긴급', es: 'He perdido mi pasaporte.', en: 'I have lost my passport.', ko: '여권을 잃어버렸어요.', say: '에 뻬르디도 미 빠사뽀르떼' },
    { cat: '긴급', es: 'Soy alérgico / alérgica a los frutos secos / al marisco.', en: "I'm allergic to nuts / seafood.", ko: '견과류 / 해산물 알레르기가 있어요. (남자 alérgico, 여자 alérgica)', say: '소이 알레르히꼬 / 알레르히까 아 로스 프루또스 세꼬스 / 알 마리스꼬' },
  ],
};
// 스페인어 카드를 보여 줄 나라 (COUNTRIES의 name). 그 밖의 해외 여행은 영어를 크게 보여 준다.
const PHRASE_LANG = { 스페인: 'es', 멕시코: 'es', 아르헨티나: 'es', 칠레: 'es', 페루: 'es', 콜롬비아: 'es' };
