#!/usr/bin/env python3

import shutil
from pathlib import Path
from PIL import Image

# 项目根目录
PROJECT_ROOT = Path(__file__).parent
SOURCE_ASSETS = PROJECT_ROOT / "manosaba_text_box" / "assets"
TARGET_ASSETS = PROJECT_ROOT / "assets"

def convert_png_to_avif(source_path: Path, target_path: Path, quality: int = 100):
    """
    转换 PNG 文件到 AVIF 格式

    Args:
        source_path: 源 PNG 文件路径
        target_path: 目标 AVIF 文件路径
        quality: AVIF 质量 (0-100)
    """
    try:
        with Image.open(source_path) as img:
            # 确保目标目录存在
            target_path.parent.mkdir(parents=True, exist_ok=True)

            # 转换为 AVIF
            img.save(target_path, "AVIF", quality=quality)

            # 输出文件大小对比
            source_size = source_path.stat().st_size / 1024
            target_size = target_path.stat().st_size / 1024
            reduction = (1 - target_size / source_size) * 100

            print(f"✓ {source_path.name} -> {target_path.name}")
            print(f"  {source_size:.1f}KB -> {target_size:.1f}KB (减少 {reduction:.1f}%)")

    except Exception as e:
        print(f"✗ 转换失败 {source_path.name}: {e}")

def copy_non_image_files(source_dir: Path, target_dir: Path):
    """
    复制非图片文件（保持目录结构）

    Args:
        source_dir: 源目录
        target_dir: 目标目录
    """
    for item in source_dir.rglob("*"):
        if item.is_file() and item.suffix.lower() not in ['.png', '.jpg', '.jpeg']:
            relative_path = item.relative_to(source_dir)
            target_path = target_dir / relative_path
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target_path)
            print(f"📄 复制: {relative_path}")

def main():
    print("=" * 60)
    print("资产转换脚本 - PNG to AVIF")
    print("=" * 60)

    # 检查源目录是否存在
    if not SOURCE_ASSETS.exists():
        print(f"❌ 错误: 源资产目录不存在: {SOURCE_ASSETS}")
        return

    # 清空目标目录
    if TARGET_ASSETS.exists():
        print(f"🗑️  清空目标目录: {TARGET_ASSETS}")
        shutil.rmtree(TARGET_ASSETS)

    TARGET_ASSETS.mkdir(parents=True, exist_ok=True)

    # 统计信息
    total_files = 0
    converted_files = 0
    total_source_size = 0
    total_target_size = 0

    print(f"\n📂 扫描目录: {SOURCE_ASSETS}")
    print("-" * 60)

    # 遍历所有 PNG 文件
    for png_file in SOURCE_ASSETS.rglob("*.png"):
        relative_path = png_file.relative_to(SOURCE_ASSETS)

        # 构建目标路径（.png -> .avif）
        target_path = TARGET_ASSETS / relative_path.with_suffix('.avif')

        # 转换文件
        convert_png_to_avif(png_file, target_path, quality=85)

        total_files += 1
        converted_files += 1
        total_source_size += png_file.stat().st_size
        total_target_size += target_path.stat().st_size

    # 复制其他文件（字体等，不包括图片）
    print("\n" + "-" * 60)
    print("复制非图片文件...")
    print("-" * 60)
    copy_non_image_files(SOURCE_ASSETS, TARGET_ASSETS)

    # 输出统计信息
    print("\n" + "=" * 60)
    print("转换完成!")
    print("=" * 60)
    print(f"总文件数: {total_files}")
    print(f"转换成功: {converted_files}")

    if total_source_size > 0:
        total_source_mb = total_source_size / 1024 / 1024
        total_target_mb = total_target_size / 1024 / 1024
        reduction = (1 - total_target_size / total_source_size) * 100

        print(f"原始大小: {total_source_mb:.2f} MB")
        print(f"转换后大小: {total_target_mb:.2f} MB")
        print(f"减少: {reduction:.1f}%")

    print(f"\n✅ 资产已保存到: {TARGET_ASSETS}")

if __name__ == "__main__":
    main()
