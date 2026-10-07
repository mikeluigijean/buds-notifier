import json
import unittest

from buds_notifier.battery import Battery, Slot, parse_budslink_state
from buds_notifier.services.budslink_service import budslink_path

# Shape observed from BudsLink 0.2.1 with Galaxy Buds3 Pro (buds out of the case).
STATE = {"computedBatteryLevel": 44,
         "battery1Level": 61, "battery1Status": "discharging",
         "battery2Level": 44, "battery2Status": "discharging",
         "battery3Level": 0, "battery3Status": "disconnected",
         "toggle1State": 2}


class BatteryTest(unittest.TestCase):
    def test_parse_observed_state(self):
        battery = parse_budslink_state(json.dumps(STATE))
        self.assertEqual(battery, Battery(left=Slot(61), right=Slot(44), case=None))

    def test_parse_charging_case(self):
        state = dict(STATE, battery3Level=80, battery3Status="charging")
        self.assertEqual(parse_budslink_state(json.dumps(state)).case, Slot(80, charging=True))

    def test_parse_not_reported_and_garbage(self):
        state = {f"battery{n}Status": "not-reported" for n in (1, 2, 3)}
        self.assertIsNone(parse_budslink_state(json.dumps(state)))
        self.assertIsNone(parse_budslink_state("not json"))

    def test_lowest_bud_excludes_case(self):
        battery = Battery(left=Slot(61), right=Slot(44), case=Slot(5))
        self.assertEqual(battery.lowest_bud(), 44)
        self.assertEqual(Battery(single=30).lowest_bud(), 30)
        self.assertIsNone(Battery(case=Slot(5)).lowest_bud())

    def test_text(self):
        self.assertEqual(Battery(left=Slot(61), right=Slot(44, True)).text(), "L 61% · R 44% (charging)")
        self.assertEqual(Battery(single=44).text(), "44%")

    def test_budslink_path_mirrors_bluez(self):
        self.assertEqual(budslink_path("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"),
                         "/io/github/maniacx/BudsLink/Devices/hci0/dev_AA_BB_CC_DD_EE_FF")


if __name__ == "__main__":
    unittest.main()
