# Java 互換の数値計算

`jmath::strict_math` は `sin`、`cos`、`tan`、`asin`、`acos`、`atan`、
`atan2`、`log`、`log10`、`exp`、`pow` を提供します。
[fdlibm 5.3](https://netlib.org/fdlibm/) のアルゴリズムと
[Java の StrictMath 仕様](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/StrictMath.html)
を出典としています。
公開されている [rust-lang/libm の Rust 移植](https://github.com/rust-lang/libm/tree/a0a5bd85c913fe5f6c42bc11ef292e575f97ca6d/src/math)
を土台にしています。後年の msun の変更を、fdlibm 5.3 の演算順序と分岐に戻しています。
ゲーム本体のコードや逆コンパイル結果は使用していません。

三角関数の範囲縮約には `__ieee754_rem_pio2` と `__kernel_rem_pio2` の方式を使います。
大きな引数は 24 ビットずつに分割します。2/π の表から必要な部分を選びます。
最大の有限値でも、ホストの数学ライブラリに依存しません。

`jmath::sin_table::SIN` は 65,536 要素の f32 配列です。
初回の参照時に一度だけ作ります。
各要素は `strict_math::sin(i as f64 * PI * 2.0 / 65536.0) as f32` です。
Java の `(float) StrictMath.sin(i * Math.PI * 2 / 65536)` と同じ順序で計算します。
`sin` と `cos` の添字計算は f32 で行います。
Rust の `as i32` は Java の `(int)` と同じ動作です。
小数部をゼロ方向に切り捨てます。範囲外は上下限に飽和します。NaN は 0 になります。

基準値を生成した OpenJDK 21.0.12.1 では、`Math.sin` と `StrictMath.sin` は
表の入力 65,536 個のうち f64 で 2,227 個異なりました。
f32 への変換後に異なる要素は **0 個**でした。
この差の数は JDK と JIT、実行環境によって変わり得ます。
生成器は両方の差の数を基準値のコメントに記録します。

`JavaRandom::next_gaussian()` は Java の極座標法を使います。
2 個目の値を保存します。次の呼び出しは乱数状態を進めずに保存値を返します。
`set_seed` は保存値を破棄します。
内部の対数には `strict_math::log` を使います。

型は Java 側の型に合わせます。Java の `float` は f32、`double` は f64 です。
f32 の中間結果を f64 で計算してから戻すと、丸めが変わることがあります。
キャストの位置と四則演算の括弧も保ちます。積和を FMA に置き換えません。
標準の `f64::sin`、`ln`、`powf` などは使用しません。

`f64::sqrt` だけは使用できます。
平方根には IEEE 754 の正しい丸めの保証があります。
同じ f64 の入力に対し、ネイティブと WASM で同じ値を得られます。
NaN の符号とペイロードは Java の仕様でも固定されていません。
基準値は `Double.doubleToLongBits` で NaN を正規化します。
それ以外は、符号付きゼロを含めて全ビットを比較します。

基準値の再生成手順は `tools/oracle/JdkVectors.java` の先頭にあります。
固定シードの入力、特殊値、分岐境界、π の倍数付近、正弦表の全要素を保存します。
既存の乱数の基準値も維持しています。
