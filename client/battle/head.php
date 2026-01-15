<?php
if (!defined('_GNUBOARD_')) exit; // 개별 페이지 접근 불가

if (defined('G5_THEME_PATH')) {
	require_once(G5_THEME_PATH . '/head.php');
	return;
}


include_once(G5_PATH . '/head.sub.php');
include_once(G5_LIB_PATH . '/latest.lib.php');
include_once(G5_LIB_PATH . '/outlogin.lib.php');
include_once(G5_LIB_PATH . '/poll.lib.php');
include_once(G5_LIB_PATH . '/visit.lib.php');
include_once(G5_LIB_PATH . '/connect.lib.php');
include_once(G5_LIB_PATH . '/popular.lib.php');

/*********** Logo Data ************/
$logo = get_logo('pc');
$m_logo = get_logo('mo');

$logo_data = "";
if ($logo)		$logo_data .= "<img src='" . $logo . "' ";
if ($m_logo)		$logo_data .= "class='only-pc' /><img src='" . $m_logo . "' class='not-pc'";
if ($logo_data)	$logo_data .= " />";
/*********************************/


/*********** ch Data ************/
$ch = array();
$ch_list = sql_query("select * from avo_character where ch_type = 'main'");
for ($i = 0; $ch_item = sql_fetch_array($ch_list); $i++) {
	$ch[$ch_item["ch_id"]] = $ch_item;
	$ch_order[$i] = $ch_item;
}

$ch_catch = sql_query("SELECT ch_id, av_value FROM `avo_article_value` where ar_code = 'catchpraise'");
for ($i = 0; $row = sql_fetch_array($ch_catch); $i++) {
	$ch[$row["ch_id"]]['catchpraise'] = $row["av_value"];
}


$ch_id = '1';
$temp_ch = true;
$ch_map = null;
$team_id = null;
$status = 'NONE';

if ($is_member) {
	$ch_id = $character["ch_id"];  //캐릭터 아이디
	$ch_map = $character["ch_map"];  //현재 맵 
	$temp_ch = false;  //임시 캐릭터
	$team_id =  $character["ch_battle"];
	$status =  $character["ch_status"];
}

/*********************************/
?>

<script>
	window.characterId = <?= (int)$ch_id ?>;
	window.isTempChar = <?= $temp_ch ? 'true' : 'false' ?>;
	window.currentMap = <?= json_encode($ch_map ?? "empty", JSON_UNESCAPED_UNICODE) ?>;
	window.chList = <?= json_encode($ch, JSON_UNESCAPED_UNICODE) ?>;
	window.dungeonList = <?= json_encode($open_dungeons, JSON_UNESCAPED_UNICODE) ?>;
	window.teamId = <?= json_encode($team_id ?? "null", JSON_UNESCAPED_UNICODE) ?>;
	window.status = <?= json_encode($status, JSON_UNESCAPED_UNICODE) ?>;
</script>

<!-- 소켓 -->
<script src="<?= G5_URL ?>/public/js/socket.io.min.js"></script>

<div id="loading">
	<div><i></i><i></i><i></i></div>
</div>

<!-- 헤더 영역 -->
<header id="header" class="main-header menu-area">
	
	<div class="glow-btn menu-item" data-rel="home" data-type="tab" data-url="/">
<svg width="800px" height="800px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M12 21C15.5 17.4 19 14.1764 19 10.2C19 6.22355 15.866 3 12 3C8.13401 3 5 6.22355 5 10.2C5 14.1764 8.5 17.4 12 21Z" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M12 12C13.1046 12 14 11.1046 14 10C14 8.89543 13.1046 8 12 8C10.8954 8 10 8.89543 10 10C10 11.1046 10.8954 12 12 12Z" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
		<i> HOME </i>
	</div>
	
	<div class="glow-btn menu-item" data-rel="team-list" data-id="team">
		<svg width="800px" height="800px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<g clip-path="url(#clip0_429_11217)">
				<path d="M4 18C4 15.7908 5.79086 14 8 14H16C18.2091 14 20 15.7908 20 18V18C20 19.1045 19.1046 20 18 20H6C4.89543 20 4 19.1045 4 18V18Z" stroke-width="2" stroke-linejoin="round" />
				<circle cx="12" cy="6.99997" r="3" stroke-width="2" />
			</g>
			<defs>
				<clipPath id="clip0_429_11217">
					<rect width="24" height="24" fill="white" />
				</clipPath>
			</defs>
		</svg>
		<i> TEAMS </i>
	</div>
	
	<div class="glow-btn menu-item" data-rel="mstd" data-type="tab" data-url="/bbs/board.php?bo_table=calc">
	<svg fill="#ededed" width="800px" height="800px" viewBox="0 0 36 36" version="1.1"  preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <path d="M21.6,29a1,1,0,0,0-1-1h-6a1,1,0,0,0,0,2h6A1,1,0,0,0,21.6,29Z" class="clr-i-outline clr-i-outline-path-1"></path><path d="M22.54,24h-6a1,1,0,0,0,0,2h6a1,1,0,0,0,0-2Z" class="clr-i-outline clr-i-outline-path-2"></path><path d="M22,32H16a1,1,0,0,0,0,2h6a1,1,0,0,0,0-2Z" class="clr-i-outline clr-i-outline-path-3"></path><path d="M32.7,32h-7a1,1,0,0,0,0,2h7a1,1,0,0,0,0-2Z" class="clr-i-outline clr-i-outline-path-4"></path><path d="M33.7,28h-7a1,1,0,0,0,0,2h7a1,1,0,0,0,0-2Z" class="clr-i-outline clr-i-outline-path-5"></path><path d="M33.74,26a28,28,0,0,0-2.82-10.12A20.24,20.24,0,0,0,24.6,8.71L27,3.42a1,1,0,0,0-.07-1A1,1,0,0,0,26.13,2H9.8a1,1,0,0,0-.91,1.42l2.45,5.31a20.33,20.33,0,0,0-6.28,7.15c-2.15,4-2.82,8.89-3,12.28a3.6,3.6,0,0,0,1,2.71A3.79,3.79,0,0,0,5.8,31.94H12V30H5.72a1.68,1.68,0,0,1-1.21-.52,1.62,1.62,0,0,1-.45-1.23c.14-2.61.69-7.58,2.76-11.45A18,18,0,0,1,13.08,10h1a30.81,30.81,0,0,0-1.87,2.92,22.78,22.78,0,0,0-1.47,3.34l1.37.92a24,24,0,0,1,1.49-3.47A29.1,29.1,0,0,1,16.05,10h1a21.45,21.45,0,0,1,1.41,5,22.54,22.54,0,0,1,.32,3.86l1.58-1.11a24.15,24.15,0,0,0-.32-3A24.82,24.82,0,0,0,18.76,10h.78l.91-2H13.21L11.36,4H24.57l-2.5,5.47a9.93,9.93,0,0,1,1.23.78,18.63,18.63,0,0,1,5.86,6.57A26.59,26.59,0,0,1,31.73,26Z" class="clr-i-outline clr-i-outline-path-6"></path>
</svg>
		<i> CALC </i>
	</div>
	
	<div class="glow-btn menu-item" data-rel="mstd" data-type="" data-url="https://mastodon.scenario-messiah.com/home">
		<svg fill="#ffffff" width="800px" height="800px" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" xml:space="preserve" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2">
			<path d="M2004.3 228h-.57c-19.87.163-38.97 2.491-50.13 7.601-.5.213-24.58 10.78-24.58 46.99 0 7.394-.14 16.236.09 25.612.4 16.438 2 32.742 7.21 45.957 5.67 14.406 15.47 25.335 32.04 29.72 14.11 3.737 26.23 4.503 35.99 3.967h.01c18.41-1.021 28.71-6.695 28.71-6.695a6.018 6.018 0 0 0 3.16-5.558l-.56-12.178a5.984 5.984 0 0 0-2.56-4.646 5.995 5.995 0 0 0-5.24-.804s-11.04 3.471-23.45 3.047c-4.87-.167-9.84-.357-14.18-1.544-3.91-1.069-7.14-3.148-8.76-7.347 5.59.951 13.45 2.021 22.27 2.425 10.49.481 20.33-.592 30.33-1.785 12.37-1.477 23.76-6.688 31.4-13.091 5.8-4.865 9.47-10.509 10.5-15.801v-.001c3.23-16.623 3.05-40.428 3.04-41.319-.01-36.286-24.23-46.801-24.58-46.951-11.14-5.105-30.25-7.436-50.14-7.599Zm59.9 93.58.09-.471c3.1-15.948 2.73-38.451 2.73-38.451v-.067c0-27.633-17.49-36.04-17.49-36.04a.234.234 0 0 0-.05-.024c-10.05-4.616-27.33-6.379-45.26-6.527h-.41c-17.93.148-35.2 1.911-45.25 6.527l-.06.024s-17.48 8.407-17.48 36.04c0 7.308-.15 16.047.09 25.314v.004c.36 14.96 1.64 29.826 6.37 41.852 4.27 10.836 11.49 19.221 23.95 22.519 12.65 3.349 23.51 4.066 32.26 3.585 9.61-.533 16.56-2.512 20.36-3.891l-.04-.739c-5.11 1.018-12.33 2.033-20 1.771-16.29-.559-32.69-3.029-35.34-23.016a40.2 40.2 0 0 1-.35-5.4 6 6 0 0 1 2.3-4.719 5.998 5.998 0 0 1 5.13-1.109s12.59 3.066 28.55 3.798c9.81.45 19.01-.598 28.36-1.713 9.88-1.18 19.01-5.258 25.11-10.372 3.36-2.814 5.83-5.834 6.43-8.895Zm-54.2-36.244c.68-2.603 3.99-12.807 14.27-12.807 10.68 0 10.54 12.137 10.54 12.137v34.224c0 3.311 2.69 6 6 6s6-2.689 6-6v-34.406s-.68-23.955-22.54-23.955c-10 0-16.43 5.292-20.4 10.778-4.07-5.273-10.62-10.293-20.78-10.293-6.92 0-11.53 2.138-14.68 4.857-6.67 5.747-6.86 14.826-6.81 16.949l.02.455s-.01-.161-.02-.455v-.052 36.342c0 3.311 2.69 6 6 6s6-2.689 6-6v-36.342c0-.169-.01-.338-.02-.507 0 0-.5-4.577 2.66-7.298 1.45-1.252 3.66-1.949 6.85-1.949 10.65 0 14.18 9.844 14.91 12.386v20.233c0 3.311 2.69 6 6 6s6-2.689 6-6v-20.297Z" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2" transform="translate(-1908 -212)" />
		</svg>
		<i> MSTD </i>
	</div>
	
	<? include(G5_PATH . "/templete/txt.bgm.php"); ?>
</header>
<!-- // 헤더 영역 -->

<div id="bottom-menu" class="main-menu menu-area">
	<!-- inventory -->
	<div class="glow-btn menu-item" data-rel="main-modal" data-type="new" data-url="./myinven" data-id="inven">
		<svg width="800px" height="800px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<g clip-path="url(#clip0_429_11091)">
				<path d="M4 8H20V18C20 19.1046 19.1046 20 18 20H6C4.89543 20 4 19.1046 4 18V8Z" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M8 4H16L20 8H4L8 4Z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M8 12H12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
			</g>
			<defs>
				<clipPath id="clip0_429_11091">
					<rect width="24" height="24" fill="white" />
				</clipPath>
			</defs>
		</svg>
		<i> INVEN</i>
	</div>
	<!-- quest -->
	<div class="glow-btn menu-item" data-rel="main-modal" data-type="new" data-id="quest" data-url="./myquest">
		<svg width="800px" height="800px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<g clip-path="url(#clip0_429_11031)">
				<path d="M3 4V18C3 19.1046 3.89543 20 5 20H17H19C20.1046 20 21 19.1046 21 18V8H17" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M3 4H17V18C17 19.1046 17.8954 20 19 20V20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M13 8L7 8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M13 12L9 12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
			</g>
			<defs>
				<clipPath id="clip0_429_11031">
					<rect width="24" height="24" fill="white" />
				</clipPath>
			</defs>
		</svg>
		<i> QUEST </i>
	</div>
	<!-- mypage -->
	<div class="glow-btn menu-item" data-rel="main-modal" data-type="new"  data-url="./myartifact" data-id="artifact">
<svg fill="#ededed" width="800px" height="800px" viewBox="0 0 256 256" id="Flat" xmlns="http://www.w3.org/2000/svg">
  <path d="M237.47852,194.54l-8.28223-30.91016h0L196.06787,39.99023a20.02074,20.02074,0,0,0-24.49463-14.14062l-29.5459,7.91663A19.92737,19.92737,0,0,0,128,28H96a19.86774,19.86774,0,0,0-8,1.68152A19.86774,19.86774,0,0,0,80,28H48A20.02229,20.02229,0,0,0,28,48V208a20.02229,20.02229,0,0,0,20,20H80a19.86774,19.86774,0,0,0,8-1.68152A19.86774,19.86774,0,0,0,96,228h32a20.02229,20.02229,0,0,0,20-20V138.78638l19.93213,74.38842a19.99048,19.99048,0,0,0,24.49463,14.14161l30.91015-8.28223h0A20.02181,20.02181,0,0,0,237.47852,194.54ZM161.09131,94.91479l23.18262-6.21142,18.63476,69.54712-23.18213,6.21191ZM173.9209,50.06641l4.1416,15.45532-23.18262,6.21142-4.14111-15.45483ZM124,164H100V52h24ZM76,52V68H52V52ZM52,92H76V204H52Zm48,112V188h24v16Zm90.0791-.90039L185.938,187.64417l23.18213-6.21192,4.14111,15.45545Z"/>
</svg>
		<i> ARTIFACT </i>
	</div>
	<!-- msg -->
	<div class="glow-btn menu-item" data-rel="main-modal" data-type="new" data-url="./mymail" data-id="mail">
		<svg width="800px" height="800px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<g clip-path="url(#clip0_429_11225)">
				<path d="M3 5H21V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V5Z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
				<path d="M3 5L12 14L21 5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
			</g>
			<defs>
				<clipPath id="clip0_429_11225">
					<rect width="24" height="24" fill="white" />
				</clipPath>
			</defs>
		</svg>
		<i> MESSAGE </i>
	</div>

	<div class="chat-icon" data-rel="login">
		<? if ($is_member) { ?> <img src="<?= $ch['ch_thumb'] ?>"> <? } else { ?> <img src="<?= G5_URL ?>/img/ui/temp_thumb.png"> <? } ?>
	</div>

</div>

<div class="main-modal hidden modal" data-rel="main-modal">

</div>

<div class="sub-modal hidden modal"> </div>

<div class="team-modal hidden team-list modal" data-rel="team-list">
	<div class="team-main-layout">
		<ul class="member-list">
			<? for ($i = 0; $i < count($ch_order); $i++) { ?>
				<li class="member-item outline-btn" data-ch_id="<?= $ch_order[$i]['ch_id'] ?>">
					<div class="ch_thumb"> <img src="<?= $ch_order[$i]['ch_thumb'] ?>"> </div>
					<div class="ch_info"> <i class="ch_msg"> <?= $ch[$ch_order[$i]['ch_id']]['catchpraise'] ?> </i> <i class="ch_name"> <?= $ch_order[$i]['ch_name'] ?> </i> </div>
				</li>
			<?  } ?>
		</ul>
	</div>
	<div class="team-sub-layout" id="team-sub-layout"> </div>
</div>

<div id="main_visual_box"> <!-- 배너 슬라이드 -->
	<? include(G5_PATH . "/templete/txt.visual.php"); ?>
</div>


<section id="body" class="main-box">
	<div class="fix-layout">