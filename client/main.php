<?php
include_once('./_common.php');
define('_MAIN_', true);

if (defined('G5_THEME_PATH')) {
	require_once(G5_THEME_PATH . '/main.php');
	return;
}

include_once(G5_PATH . '/head.php');

add_stylesheet('<link rel="stylesheet" href="' . G5_CSS_URL . '/main.css">', 0);

include_once(G5_PATH . "/intro.php");

$is_chat == false;
if ($is_member) {
	$is_chat = true;
	$is_battle = true;
}
if ($character['ch_status'] == 'IN_BATTLE') {
	goto_url('/battle');
}
?>


<div id="main_body">
	<div id="explore-area" class="explore-area">
		<?php
		if ($is_member) {
			include(G5_PATH . '/explore/index.php');
		} else {
			include(G5_PATH . '/explore/index_temp.php');
		}
		?>
		<div class="panel">
			<span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> 이동 ·
			<span class="kbd">E</span> 상호작용 ·
			<span class="kbd">↑/↓</span> & <span class="kbd">Enter</span> 선택/확인 ·
			<span class="kbd">Esc</span> 닫기
		</div>
	</div>

	<? if ($is_member) {
		if ($is_chat) {
			include(G5_PATH . '/chat/index.php');
		}

		if ($is_battle) {
			include(G5_PATH . '/team/index.php');
		}
	} ?>
</div>

<script>
	$(function() {
		window.onload = function() {
			$('#body').css('opacity', 1);
		};
	});
</script>

<?
include_once(G5_PATH . '/tail.php');
?>
