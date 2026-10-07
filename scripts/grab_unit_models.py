#!/usr/bin/env python3
"""提取 TerenasStand 地图用到的单位/建筑模型 (MDX+贴图) 进 war3_extracted/。

复用 foc-web 管线 extract_blizzard.py 的 grab_model()（从 MPQ 提 MDX 及其
TEXS 引用的全部贴图），不自己造轮子。之后重跑 mdx2gltf.py 即可转 glTF。

用法: 在 /mnt/shared/war3/foc-web/ 目录下执行:
    .venv/bin/python ../scripts/grab_unit_models.py
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FOC = os.path.normpath(os.path.join(HERE, '..', 'foc-web'))
os.chdir(FOC)
sys.path.insert(0, os.path.join(FOC, 'tools'))

# TerenasStand 地图实际放置的单位模型（unittypes.json 的 model 字段，去重）
UNIT_MODELS = [
    'buildings\\other\\Tavern\\Tavern.mdl',
    'buildings\\other\\Merchant\\Merchant.mdl',
    'buildings\\other\\Mercenary\\Mercenary.mdl',
    'buildings\\other\\AmmoDump\\AmmoDump.mdl',
    'units\\creeps\\HumanMage\\HumanMage.mdl',
    'units\\creeps\\Kobold\\Kobold.mdl',
    'units\\creeps\\KoboldGeomancer\\KoboldGeomancer.mdl',
    'units\\creeps\\BanditMage\\BanditMage.mdl',
    'units\\creeps\\Bandit\\Bandit.mdl',
    'units\\creeps\\BanditSpearThrower\\BanditSpearThrower.mdl',
    'units\\creeps\\ForestTroll\\ForestTroll.mdl',
    'units\\creeps\\ForestTrollShadowPriest\\ForestTrollShadowPriest.mdl',
    'units\\creeps\\MurlocWarrior\\MurlocWarrior.mdl',
    'units\\creeps\\MurlocNightcrawler\\MurlocNightcrawler.mdl',
    'units\\creeps\\Sasquatch\\Sasquatch.mdl',
    'units\\creeps\\RockGolem\\RockGolem.mdl',
    'buildings\\other\\GoldMine\\GoldMine.mdl',
]

def main():
    print('== import extract_blizzard (幂等全流程, 提 UI/表等) ==')
    import extract_blizzard as eb
    ok = miss = 0
    for ap in UNIT_MODELS:
        # resolve: 小写路径 → listfile 原始大小写 (hash 查找区分大小写)
        orig = eb.resolve(ap)
        if not orig:
            print('  NO-RESOLVE', ap)
            miss += 1
            continue
        if eb.grab_model(orig):
            print('  grab OK  ', orig)
            ok += 1
        else:
            print('  MISS     ', orig)
            miss += 1
    print('grab %d ok, %d miss' % (ok, miss))
    if miss:
        sys.exit(1)

if __name__ == '__main__':
    main()
