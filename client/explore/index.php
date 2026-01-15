<?
include_once('./_common.php');

$ch_id = '1';
$temp_ch = true;

if ($character["ch_id"]) {
	$ch_id = $character["ch_id"];
	$temp_ch = false;
}

if ($character["ch_status"] == "IN_BATTLE") {
	header("Location: https://scenario-messiah.com/battle/index.php?raid_id={$character['ch_battle']}");
	exit;
}

?>

<html lang="ko">

<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width,initial-scale=1" />
</head>

<body>

	<div id="ui">
		<!---	<strong>WASD</strong> 이동 • <strong>E</strong> 상호작용 • <strong>↑/↓ 또는 숫자키</strong>로 선택 • <strong>Enter</strong>로 확정 • <strong>Esc</strong> 닫기   -->
		<span id="hint"></span>
	</div>


	<canvas id="game" width="1024" height="768"></canvas>
	<div id="bubbles"></div>

	<div id="dialogueBox">
		<p id="dialogueText"></p>
		<div id="choices"></div>
	</div>

	<div id="resetBtn"></div>

	<script src="<?= G5_URL ?>/public/js/socket.io.min.js"></script>
	<script type="module" src="./explore/main.js"></script>
</body>