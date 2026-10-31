// Stage list. Optional images: assets/stages/01.png … 07.png (same order).
// Game 1 uses the first 6 (starter) stages; games 2-3 use all of them.
window.STAGES = ['終点', '戦場', 'ポケモンスタジアム2', '小戦場', 'ホロウバスティオン', '村と街', 'すま村'];
window.STARTER_COUNT = 6;
window.MAX_REJECT = 2;

// Fighter roster. Images: assets/roster/01.png … (same order).
// assets/fighters/ keeps the numbering from before the Mii fighter became three (one fewer image
// per position from Palutena on), only for tabs opened before that update; remove it in a later release.
window.FIGHTERS = [
  'マリオ', 'ドンキーコング', 'リンク', 'サムス', 'ダークサムス', 'ヨッシー', 'カービィ', 'フォックス',
  'ピカチュウ', 'ルイージ', 'ネス', 'キャプテン・ファルコン', 'プリン', 'ピーチ', 'デイジー', 'クッパ',
  'アイスクライマー', 'シーク', 'ゼルダ', 'ドクターマリオ', 'ピチュー', 'ファルコ', 'マルス', 'ルキナ',
  'こどもリンク', 'ガノンドロフ', 'ミュウツー', 'ロイ', 'クロム', 'Mr.ゲーム&ウォッチ', 'メタナイト', 'ピット',
  'ブラックピット', 'ゼロスーツサムス', 'ワリオ', 'スネーク', 'アイク', 'ポケモントレーナー', 'ディディーコング', 'リュカ',
  'ソニック', 'デデデ', 'ピクミン&オリマー', 'ルカリオ', 'ロボット', 'トゥーンリンク', 'ウルフ', 'むらびと',
  'ロックマン', 'Wii Fit トレーナー', 'ロゼッタ&チコ', 'リトル・マック', 'ゲッコウガ', '格闘Mii', '剣術Mii', '射撃Mii',
  'パルテナ', 'パックマン', 'ルフレ', 'シュルク', 'クッパJr.', 'ダックハント', 'リュウ', 'ケン',
  'クラウド', 'カムイ', 'ベヨネッタ', 'インクリング', 'リドリー', 'シモン', 'リヒター', 'キングクルール',
  'しずえ', 'ガオガエン', 'パックンフラワー', 'ジョーカー', '勇者', 'バンジョー&カズーイ', 'テリー', 'ベレト/ベレス',
  'ミェンミェン', 'スティーブ/アレックス', 'セフィロス', 'ホムラ/ヒカリ', 'カズヤ', 'ソラ',
];
// Names that only appear in records from before the roster changed (the Miis used to be one fighter)
window.OLD_FIGHTER_IMAGES = { 'Miiファイター': 'assets/roster/mii.png' };
