/**
 * The map's chat commands, recovered.
 *
 * war3map.j reaches us with every byte above 127 replaced by an underscore --
 * done to the map before we ever saw it, and not by our extraction: the block
 * inside the .w3x is byte for byte the file on disk. That leaves the two
 * commands the map registers as `-__` and `-____`, which a player can type but
 * would never think to.
 *
 * They are recoverable because the map documents them in its own quest text,
 * which is in war3map.wts and kept its Korean. STRING 9563 reads:
 *
 *     * '-듀얼제거' 를 빨강이 입력하시면 듀얼은 제거됩니다.
 *     * '-숨김해제' 를 입력하시면 버그로인해 없어진 유닛이 10초뒤 보입니다.
 *     * '-조합' 을 입력하시면 조합목록이 나옵니다.
 *     * '-위치저장' 을 입력하시면 캐릭터의 현재위치가 저장됩니다.
 *
 * The protection replaced one underscore per CHARACTER, not per byte, which the
 * counts settle: `-__` is two characters and `-____` is four. That alone names
 * `-조합`, the only two-character command in the list. It leaves three
 * candidates for the four-character one, and what the trigger DOES decides
 * between them -- see each entry below. The other two commands in the quest
 * text are not registered by this version of the script at all.
 *
 * Hand-written and kept in source rather than in data/, which is regenerated
 * and not committed. Two entries, each with the evidence that fixes it.
 */
export const CHAT_ALIAS = new Map([
  // Displays TRIGSTR_8680, which is the item combination list -- "챔피언밸트 +
  // 미스릴방패 = 황금 방패" and six more. The quest text: "'-조합' 을
  // 입력하시면 조합목록이 나옵니다" -- type -조합 and the combination list
  // appears. Two characters, and it is the only two-character command.
  ['-조합', '-__'],
  // Registered to Player(0) alone, and its action destroys the duel's timer
  // dialog, re-enables the two triggers the duel had switched off and unpauses
  // everything. The quest text: "'-듀얼제거' 를 빨강이 입력하시면 듀얼은
  // 제거됩니다" -- if RED types -듀얼제거, the duel is removed. The
  // player restriction is what separates it from the other two four-character
  // candidates, neither of which is red-only or touches the duel.
  ['-듀얼제거', '-____'],
]);

/**
 * What to hand the map's chat triggers for a line a player typed.
 *
 * The literal the script registered is what the trigger compares against, so a
 * recovered command is translated back to it. Anything else passes through --
 * including the mangled form itself, which still works for anyone who knows it.
 */
export function chatFor(text) {
  return CHAT_ALIAS.get(String(text || '').trim()) || text;
}
