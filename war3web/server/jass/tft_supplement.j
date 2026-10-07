//============================================================================
// Frozen Throne additions missing from the Reign of Chaos common.j/Blizzard.j
// found in war3.mpq. Constants keep TFT's numbering; the BJ helpers are the
// standard Blizzard.j wrappers. Replace this file by extracting the real
// Scripts\common.j and Scripts\Blizzard.j from War3x.mpq / War3Patch.mpq.
//============================================================================
globals
    constant playerunitevent EVENT_PLAYER_UNIT_SELL                  = ConvertPlayerUnitEvent(52)
    constant playerunitevent EVENT_PLAYER_UNIT_CHANGE_OWNER          = ConvertPlayerUnitEvent(53)
    constant playerunitevent EVENT_PLAYER_UNIT_SELL_ITEM             = ConvertPlayerUnitEvent(54)
    constant playerunitevent EVENT_PLAYER_UNIT_SPELL_CHANNEL         = ConvertPlayerUnitEvent(55)
    constant playerunitevent EVENT_PLAYER_UNIT_SPELL_CAST            = ConvertPlayerUnitEvent(56)
    constant playerunitevent EVENT_PLAYER_UNIT_SPELL_EFFECT          = ConvertPlayerUnitEvent(57)
    constant playerunitevent EVENT_PLAYER_UNIT_SPELL_FINISH          = ConvertPlayerUnitEvent(58)
    constant playerunitevent EVENT_PLAYER_UNIT_SPELL_ENDCAST         = ConvertPlayerUnitEvent(59)
    constant playerunitevent EVENT_PLAYER_UNIT_PAWN_ITEM             = ConvertPlayerUnitEvent(60)
    constant playerevent     EVENT_PLAYER_LEAVE                      = ConvertPlayerEvent(2)
    constant unitevent       EVENT_UNIT_SPELL_EFFECT                 = ConvertUnitEvent(308)

    // player score categories (used by the map's kill counter and win condition)
    constant playerscore PLAYER_SCORE_UNITS_TRAINED   = ConvertPlayerScore(0)
    constant playerscore PLAYER_SCORE_UNITS_KILLED    = ConvertPlayerScore(1)
    constant playerscore PLAYER_SCORE_STRUCT_BUILT    = ConvertPlayerScore(2)
    constant playerscore PLAYER_SCORE_STRUCT_RAZED    = ConvertPlayerScore(3)
    constant playerscore PLAYER_SCORE_TECH_PERCENT    = ConvertPlayerScore(4)
    constant playerscore PLAYER_SCORE_FOOD_MAXPROD    = ConvertPlayerScore(5)
    constant playerscore PLAYER_SCORE_FOOD_MAXUSED    = ConvertPlayerScore(6)
    constant playerscore PLAYER_SCORE_HEROES_KILLED   = ConvertPlayerScore(7)
    constant playerscore PLAYER_SCORE_ITEMS_GAINED    = ConvertPlayerScore(8)
    constant playerscore PLAYER_SCORE_MERCS_HIRED     = ConvertPlayerScore(9)
    constant playerscore PLAYER_SCORE_GOLD_MINED_TOTAL = ConvertPlayerScore(10)
    constant playerscore PLAYER_SCORE_GOLD_MINED_UPKEEP = ConvertPlayerScore(11)
    constant playerscore PLAYER_SCORE_GOLD_LOST_UPKEEP = ConvertPlayerScore(12)
    constant playerscore PLAYER_SCORE_GOLD_LOST_TAX   = ConvertPlayerScore(13)
    constant playerscore PLAYER_SCORE_GOLD_GIVEN      = ConvertPlayerScore(14)
    constant playerscore PLAYER_SCORE_GOLD_RECEIVED   = ConvertPlayerScore(15)
    constant playerscore PLAYER_SCORE_LUMBER_TOTAL    = ConvertPlayerScore(16)
    constant playerscore PLAYER_SCORE_LUMBER_LOST_UPKEEP = ConvertPlayerScore(17)
    constant playerscore PLAYER_SCORE_LUMBER_LOST_TAX = ConvertPlayerScore(18)
    constant playerscore PLAYER_SCORE_LUMBER_GIVEN    = ConvertPlayerScore(19)
    constant playerscore PLAYER_SCORE_LUMBER_RECEIVED = ConvertPlayerScore(20)
    constant playerscore PLAYER_SCORE_UNIT_TOTAL      = ConvertPlayerScore(21)
    constant playerscore PLAYER_SCORE_HERO_TOTAL      = ConvertPlayerScore(22)
    constant playerscore PLAYER_SCORE_RESOURCE_TOTAL  = ConvertPlayerScore(23)
    constant playerscore PLAYER_SCORE_TOTAL           = ConvertPlayerScore(24)
endglobals

native DestroyGroup                 takes group whichGroup returns nothing
native GetSpellAbilityId            takes nothing returns integer
native GetSpellAbilityUnit          takes nothing returns unit
native GetSpellTargetUnit           takes nothing returns unit
native GetSpellTargetLoc            takes nothing returns location
native GetEventDamageSource         takes nothing returns unit
native UnitAddAbility               takes unit whichUnit, integer abilityId returns boolean
native UnitRemoveAbility            takes unit whichUnit, integer abilityId returns boolean
native UnitMakeAbilityPermanent     takes unit whichUnit, boolean permanent, integer abilityId returns boolean
native UnitResetCooldown            takes unit whichUnit returns boolean
native GetUnitUserData              takes unit whichUnit returns integer
native SetUnitUserData              takes unit whichUnit, integer data returns nothing
native GetUnitLifePercent           takes unit whichUnit returns real
native GetHeroProperName            takes unit whichUnit returns string
native GetObjectName                takes integer objectId returns string
native GetPlayerScore               takes player whichPlayer, playerscore whichPlayerScore returns integer
native DestroyLightning             takes lightning whichBolt returns boolean
native AddLightningLoc              takes string codeName, location where1, location where2 returns lightning
native DestroyTextTag               takes texttag t returns nothing
native VersionGet                   takes nothing returns version
native SelectUnitForPlayerSingle    takes unit whichUnit, player whichPlayer returns nothing
native ClearSelectionForPlayer      takes player whichPlayer returns nothing
native SetAllItemTypeSlots          takes integer slots returns nothing
native SetAllUnitTypeSlots          takes integer slots returns nothing
native CameraSetEQNoiseForPlayer    takes player whichPlayer, real magnitude returns nothing
native RotateCameraAroundLocBJ      takes real degrees, location point, player whichPlayer, real duration returns nothing
native TerrainDeformationCraterBJ   takes real duration, boolean permanent, location where, real radius, real depth returns terraindeformation
native TerrainDeformationRippleBJ   takes real duration, boolean limitNeg, location where, real startRadius, real endRadius, real depth, real waveDistance, real waveTime returns terraindeformation
native TerrainDeformationWaveBJ     takes real duration, location source, location target, real radius, real depth, real trailDelay returns terraindeformation
native DelayedSuspendDecayCreate    takes nothing returns nothing
native LeaderboardGetPlayerIndex     takes leaderboard lb, player p returns integer

//============================ standard Blizzard.j wrappers ==================
function TriggerRegisterAnyUnitEventBJ takes trigger trig, playerunitevent whichEvent returns nothing
    local integer index = 0
    loop
        call TriggerRegisterPlayerUnitEvent(trig, Player(index), whichEvent, null)
        set index = index + 1
        exitwhen index == bj_MAX_PLAYER_SLOTS
    endloop
endfunction

function TriggerRegisterPlayerEventLeave takes trigger trig, player whichPlayer returns event
    return TriggerRegisterPlayerEvent(trig, whichPlayer, EVENT_PLAYER_LEAVE)
endfunction

function ForGroupBJ takes group whichGroup, code callback returns nothing
    call ForGroup(whichGroup, callback)
endfunction

function UnitDamageTargetBJ takes unit whichUnit, unit target, real amount, attacktype whichAttack, damagetype whichDamage returns boolean
    return UnitDamageTarget(whichUnit, target, amount, true, false, whichAttack, whichDamage, WEAPON_TYPE_WHOKNOWS)
endfunction

function UnitApplyTimedLifeBJ takes real duration, integer buffId, unit whichUnit returns nothing
    call UnitApplyTimedLife(whichUnit, buffId, duration)
endfunction

function UnitHasBuffBJ takes unit whichUnit, integer buffcode returns boolean
    return GetUnitAbilityLevel(whichUnit, buffcode) > 0
endfunction

function GetHeroStatBJ takes integer whichStat, unit whichHero, boolean includeBonuses returns integer
    if (whichStat == bj_HEROSTAT_STR) then
        return GetHeroStr(whichHero, includeBonuses)
    elseif (whichStat == bj_HEROSTAT_AGI) then
        return GetHeroAgi(whichHero, includeBonuses)
    elseif (whichStat == bj_HEROSTAT_INT) then
        return GetHeroInt(whichHero, includeBonuses)
    endif
    return 0
endfunction

function GetUnitAbilityLevelSwapped takes integer abilcode, unit whichUnit returns integer
    return GetUnitAbilityLevel(whichUnit, abilcode)
endfunction

function SetUnitAbilityLevelSwapped takes integer abilcode, unit whichUnit, integer level returns integer
    return SetUnitAbilityLevel(whichUnit, abilcode, level)
endfunction

function CreateTextTagLocBJ takes string s, location loc, real zOffset, real size, real red, real green, real blue, real transparency returns texttag
    set bj_lastCreatedTextTag = CreateTextTag()
    call SetTextTagText(bj_lastCreatedTextTag, s, size * 0.023 / 10)
    call SetTextTagPos(bj_lastCreatedTextTag, GetLocationX(loc), GetLocationY(loc), zOffset)
    call SetTextTagColor(bj_lastCreatedTextTag, PercentTo255(red), PercentTo255(green), PercentTo255(blue), PercentTo255(100.0 - transparency))
    return bj_lastCreatedTextTag
endfunction

function CreateTextTagUnitBJ takes string s, unit whichUnit, real zOffset, real size, real red, real green, real blue, real transparency returns texttag
    set bj_lastCreatedTextTag = CreateTextTag()
    call SetTextTagText(bj_lastCreatedTextTag, s, size * 0.023 / 10)
    call SetTextTagPosUnit(bj_lastCreatedTextTag, whichUnit, zOffset)
    call SetTextTagColor(bj_lastCreatedTextTag, PercentTo255(red), PercentTo255(green), PercentTo255(blue), PercentTo255(100.0 - transparency))
    return bj_lastCreatedTextTag
endfunction

function SetTextTagTextBJ takes texttag tt, string s, real size returns nothing
    call SetTextTagText(tt, s, size * 0.023 / 10)
endfunction

function SetTextTagVelocityBJ takes texttag tt, real speed, real angle returns nothing
    call SetTextTagVelocity(tt, speed * Cos(angle * bj_DEGTORAD) * 0.071 / 128, speed * Sin(angle * bj_DEGTORAD) * 0.071 / 128)
endfunction

function SetTextTagPermanentBJ takes texttag tt, boolean flag returns nothing
    call SetTextTagPermanent(tt, flag)
endfunction

function SetTextTagLifespanBJ takes texttag tt, real lifespan returns nothing
    call SetTextTagLifespan(tt, lifespan)
endfunction

function SetTextTagFadepointBJ takes texttag tt, real fadepoint returns nothing
    call SetTextTagFadepoint(tt, fadepoint)
endfunction

function PlaySoundAtPointBJ takes sound soundHandle, real volumePercent, location loc, real z returns nothing
    call SetSoundPosition(soundHandle, GetLocationX(loc), GetLocationY(loc), z)
    call SetSoundVolume(soundHandle, PercentToInt(volumePercent, 127))
    call StartSound(soundHandle)
endfunction

function PlaySoundOnUnitBJ takes sound soundHandle, real volumePercent, unit whichUnit returns nothing
    call AttachSoundToUnit(soundHandle, whichUnit)
    call SetSoundVolume(soundHandle, PercentToInt(volumePercent, 127))
    call StartSound(soundHandle)
endfunction
